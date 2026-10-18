"""Schema B（兩層 entitlement）regression check。

核心情境 = 舊單列 PK 的洞：同帳號跨商店兩筆購買（iPhone 月訂 + Android 賣斷）→
舊 schema 只留最高階、丟掉另一筆 token → RTDN 用被丟的 token 查無 license 直接忽略
→「月訂還在扣款但 app 顯示 Free」。Schema B 每筆購買一列，licenses 降為投影。
"""
import base64
import hashlib
import json
import os
import sys
import tempfile
import time
import types
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

import _test_env

_test_env.apply()
import aegistrans_routes as routes  # noqa: E402


def _fake_google_modules():
    """RTDN 端點 handler 內 import google.oauth2 / google.auth — 測試環境沒裝，注入假模組。"""
    id_token = types.ModuleType("google.oauth2.id_token")
    id_token.verify_oauth2_token = lambda tok, req, aud: {
        "email": "pubsub-sa@test", "email_verified": True,
    }
    oauth2 = types.ModuleType("google.oauth2")
    oauth2.id_token = id_token
    transport_requests = types.ModuleType("google.auth.transport.requests")
    transport_requests.Request = lambda: None
    transport = types.ModuleType("google.auth.transport")
    transport.requests = transport_requests
    auth = types.ModuleType("google.auth")
    auth.transport = transport
    google = types.ModuleType("google")
    google.oauth2 = oauth2
    google.auth = auth
    for name, mod in {
        "google": google, "google.oauth2": oauth2, "google.oauth2.id_token": id_token,
        "google.auth": auth, "google.auth.transport": transport,
        "google.auth.transport.requests": transport_requests,
    }.items():
        sys.modules.setdefault(name, mod)


class SchemaBTest(unittest.TestCase):
    MONTHLY = "com.aegisrd.aegistrans.pro.monthly"
    LIFETIME = "com.aegisrd.aegistrans.pro.lifetime"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        routes.DB_PATH = os.path.join(self.tmp.name, "schema-b.db")
        routes.JWT_SECRET = "test-only-secret"
        routes.GOOGLE_PUBSUB_AUDIENCE = "https://test/aegistrans/subscription/google-notifications"
        routes.GOOGLE_PUBSUB_SERVICE_ACCOUNT = "pubsub-sa@test"
        _fake_google_modules()
        routes.create_aegistrans_tables()
        now = int(time.time())
        self.now = now
        self.user_id = "user-schema-b"
        self.sid = "sid-schema-b"
        with routes.get_db() as conn:
            conn.execute(
                "INSERT INTO aegistrans_users(id,email,created_at,last_seen_at) VALUES (?,?,?,?)",
                (self.user_id, "b@example.com", now, now),
            )
            conn.execute(
                "INSERT INTO aegistrans_sessions(sid,user_id,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?)",
                (self.sid, self.user_id, now, now, now + 3600),
            )
        self.jwt = routes.sign_jwt({
            "sub": self.user_id, "email": "b@example.com", "sid": self.sid,
            "iat": now, "exp": now + 3600,
        })
        self.calls = []
        self.google_state = "SUBSCRIPTION_STATE_ACTIVE"
        self.google_expiry = "2099-01-01T00:00:00Z"
        self.original_request = routes._google_play_request
        routes._google_play_request = self._fake_google_request
        app = FastAPI()
        app.include_router(routes.create_aegistrans_router())
        app.include_router(routes.create_aegistrans_subscription_router())
        self.client = TestClient(app)

    def tearDown(self):
        routes._google_play_request = self.original_request
        self.tmp.cleanup()

    def _fake_google_request(self, method, path):
        self.calls.append((method, path))
        if method == "POST":
            return {}
        if "/purchases/products/" in path:  # one-time (lifetime)
            return {
                "productId": self.LIFETIME,
                "purchaseState": 0,
                "consumptionState": 0,
                "acknowledgementState": 0,
                "obfuscatedExternalAccountId": routes._expected_app_account_token(self.user_id),
            }
        return {  # subscriptionsv2
            "subscriptionState": self.google_state,
            "acknowledgementState": "ACKNOWLEDGEMENT_STATE_PENDING",
            "externalAccountIdentifiers": {
                "obfuscatedExternalAccountId": routes._expected_app_account_token(self.user_id),
            },
            "lineItems": [{"productId": self.MONTHLY, "expiryTime": self.google_expiry}],
        }

    # ---- helpers ----
    def _insert_apple_purchase(self, tier, expires_at, external_id="apple-tx-1"):
        with routes.get_db() as conn:
            conn.execute(
                "INSERT INTO aegistrans_purchases (external_id,user_id,store,product_id,tier,"
                "state,source,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (external_id, self.user_id, "apple",
                 f"com.aegisrd.aegistrans.{'pro.lifetime' if tier == 'pro_lifetime' else 'pro.monthly'}",
                 tier, "active", "apple", expires_at, self.now, self.now),
            )
            routes._recompute_entitlement(conn, self.user_id)

    def _verify_google(self, product_id, product_type, token):
        return self.client.post(
            "/aegistrans/subscription/verify-google",
            headers={"Authorization": f"Bearer {self.jwt}"},
            json={"productId": product_id, "purchaseToken": token, "productType": product_type},
        )

    def _status(self):
        return self.client.get(
            "/aegistrans/subscription/status",
            headers={"Authorization": f"Bearer {self.jwt}"},
        )

    def _rtdn(self, token, notification_type):
        notice = {
            "packageName": "com.aegisrd.aegistrans",
            "eventTimeMillis": str(int(time.time() * 1000)),
            "subscriptionNotification": {
                "purchaseToken": token, "notificationType": notification_type,
            },
        }
        envelope = {"message": {"data": base64.b64encode(json.dumps(notice).encode()).decode()}}
        return self.client.post(
            "/aegistrans/subscription/google-notifications",
            headers={"Authorization": "Bearer fake-oidc"},
            json=envelope,
        )

    # ---- tests ----
    def test_cross_store_purchases_coexist_and_project_highest(self):
        """iPhone 月訂 + Android 賣斷 → 兩列並存、entitlement=lifetime、月訂 token 沒被丟。"""
        month_exp = self.now + 20 * 86400
        self._insert_apple_purchase("pro_monthly", month_exp)
        resp = self._verify_google(self.LIFETIME, "inapp", "google-lifetime-token-000001")
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertEqual(body["tier"], "pro_lifetime")
        with routes.get_db() as conn:
            rows = conn.execute(
                "SELECT store, tier, state FROM aegistrans_purchases WHERE user_id=? ORDER BY store",
                (self.user_id,),
            ).fetchall()
        self.assertEqual([(r["store"], r["tier"], r["state"]) for r in rows],
                         [("apple", "pro_monthly", "active"), ("google", "pro_lifetime", "active")])
        # Apple 訂閱還在扣款 → 出現在提醒清單（server 不能取消 Apple 訂閱，只能提醒）
        self.assertEqual(
            [(r["store"], r["tier"]) for r in body["redundant_subscriptions"]],
            [("apple", "pro_monthly")],
        )

    def test_rtdn_finds_own_token_even_with_higher_entitlement(self):
        """原 bug 重現測試：google 月訂 + apple 賣斷 → RTDN(EXPIRED) 用月訂 token 仍找得到列、
        月訂標 expired、entitlement 保持 lifetime。舊 schema 這裡是 no matching license。"""
        token = "google-monthly-token-000000000001"
        resp = self._verify_google(self.MONTHLY, "subs", token)
        self.assertEqual(resp.status_code, 200, resp.text)
        self._insert_apple_purchase("pro_lifetime", None, external_id="apple-lt-1")
        # RTDN: 月訂過期
        self.google_state = "SUBSCRIPTION_STATE_EXPIRED"
        self.google_expiry = "2000-01-01T00:00:00Z"
        r = self._rtdn(token, 13)  # SUBSCRIPTION_EXPIRED
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json().get("state"), "expired")
        self.assertNotIn("no matching", json.dumps(r.json()))
        status = self._status().json()
        self.assertEqual(status["tier"], "pro_lifetime")  # 沒被打回 free

    def test_lifetime_upgrade_auto_cancels_google_sub(self):
        """跨商店升級：有 google 月訂（active）再買賣斷 → server 呼叫 cancel API、
        月訂列轉 cancelled、提醒清單為空（Google 端不需要使用者手動取消）。"""
        token = "google-monthly-token-000000000002"
        self._verify_google(self.MONTHLY, "subs", token)
        resp = self._verify_google(self.LIFETIME, "inapp", "google-lifetime-token-000002")
        self.assertEqual(resp.status_code, 200, resp.text)
        cancel_calls = [p for m, p in self.calls if m == "POST" and p.endswith(":cancel")]
        self.assertEqual(len(cancel_calls), 1)
        self.assertIn(self.MONTHLY, cancel_calls[0])
        with routes.get_db() as conn:
            row = conn.execute(
                "SELECT state FROM aegistrans_purchases WHERE user_id=? AND tier='pro_monthly'",
                (self.user_id,),
            ).fetchone()
        self.assertEqual(row["state"], "cancelled")
        body = resp.json()
        self.assertEqual(body["tier"], "pro_lifetime")
        self.assertEqual(body["redundant_subscriptions"], [])

    def test_dev_set_tier_free_does_not_clobber_real_purchase(self):
        """dev-set-tier 是測試工具：free 只清 dev 列，真商店購買不動。"""
        routes.AEGISTRANS_DEV_MODE = True
        os.environ["AEGISTRANS_DEV_ADMIN_EMAILS"] = "b@example.com"
        try:
            self._verify_google(self.LIFETIME, "inapp", "google-lifetime-token-000003")
            set_pro = self.client.post(
                "/aegistrans/subscription/dev-set-tier",
                headers={"Authorization": f"Bearer {self.jwt}"},
                json={"tier": "pro_monthly", "expires_in_seconds": 3600},
            )
            self.assertEqual(set_pro.status_code, 200, set_pro.text)
            self.assertEqual(set_pro.json()["tier"], "pro_lifetime")  # 投影取最高
            set_free = self.client.post(
                "/aegistrans/subscription/dev-set-tier",
                headers={"Authorization": f"Bearer {self.jwt}"},
                json={"tier": "free"},
            )
            self.assertEqual(set_free.json()["tier"], "pro_lifetime")  # 真購買仍在
        finally:
            routes.AEGISTRANS_DEV_MODE = False
            os.environ.pop("AEGISTRANS_DEV_ADMIN_EMAILS", None)

    def test_migration_moves_legacy_license_row(self):
        """既有單列 licenses（升版前的資料）→ 開機 migration 搬進 purchases、entitlement 不變。"""
        with routes.get_db() as conn:
            conn.execute("DELETE FROM aegistrans_purchases")
            conn.execute("DELETE FROM aegistrans_licenses")
            conn.execute(
                "INSERT INTO aegistrans_licenses (user_id,tier,source,expires_at,external_id,"
                "created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
                (self.user_id, "pro_monthly", "apple_sandbox", self.now + 86400,
                 "apple-legacy-tx", self.now, self.now),
            )
        routes.create_aegistrans_tables()  # 冪等：再跑一次含 migration
        with routes.get_db() as conn:
            row = conn.execute(
                "SELECT store, tier, state, source FROM aegistrans_purchases WHERE external_id=?",
                ("apple-legacy-tx",),
            ).fetchone()
        self.assertEqual((row["store"], row["tier"], row["state"], row["source"]),
                         ("apple", "pro_monthly", "active", "apple_sandbox"))
        self.assertEqual(self._status().json()["tier"], "pro_monthly")


class GoogleLineItemTest(unittest.TestCase):
    """review P2：deferred replacement 時 lineItems 有舊+新兩筆，productId 與 expiryTime 不可各取所需。"""
    def test_verify_picks_matching_product_expiry_pair(self):
        # 舊 monthly 先過期 + 新 yearly 晚過期，同時存在
        items = [
            {"productId": "com.aegisrd.aegistrans.pro.monthly", "expiryTime": "2030-01-01T00:00:00Z"},
            {"productId": "com.aegisrd.aegistrans.pro.yearly", "expiryTime": "2099-01-01T00:00:00Z"},
        ]
        pid, exp = routes._pick_google_line_item(items, prefer_product_id="com.aegisrd.aegistrans.pro.monthly")
        self.assertEqual(pid, "com.aegisrd.aegistrans.pro.monthly")
        self.assertEqual(exp, routes._rfc3339_unix("2030-01-01T00:00:00Z"))  # 不是 2099（不混用最大 expiry）

    def test_rtdn_picks_latest_expiry_pair(self):
        items = [
            {"productId": "com.aegisrd.aegistrans.pro.monthly", "expiryTime": "2030-01-01T00:00:00Z"},
            {"productId": "com.aegisrd.aegistrans.pro.yearly", "expiryTime": "2099-01-01T00:00:00Z"},
        ]
        pid, exp = routes._pick_google_line_item(items)  # 無指定 → 取生效中(晚 expiry)那筆
        self.assertEqual(pid, "com.aegisrd.aegistrans.pro.yearly")
        self.assertEqual(exp, routes._rfc3339_unix("2099-01-01T00:00:00Z"))

    def test_missing_product_returns_none(self):
        items = [{"productId": "com.aegisrd.aegistrans.pro.yearly", "expiryTime": "2099-01-01T00:00:00Z"}]
        self.assertEqual(routes._pick_google_line_item(items, prefer_product_id="not.a.product"), (None, None))
        self.assertEqual(routes._pick_google_line_item([]), (None, None))


if __name__ == "__main__":
    unittest.main()
