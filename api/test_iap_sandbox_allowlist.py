"""IAP sandbox 白名單 regression check。

背景：Apple 審核員的購買一律走 sandbox。上線後全域 IAP_ALLOW_SANDBOX 必須關掉（否則任何人
都能用免費的 sandbox 交易換 Pro），但若一併關掉 sandbox 驗章，審核員按購買就會被拒 →
以「IAP 無法完成」拒審。折衷 = 只有白名單裡的 user_id 接受 sandbox 收據。

這支測試盯住的就是那個 gate：白名單外的人絕不能拿到 sandbox verifier。
"""
import os
import sys
import tempfile
import time
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

import _test_env

_test_env.apply()
import aegistrans_routes as routes  # noqa: E402


class _FakeVerifier:
    """驗章一律失敗 → 端點回 400。我們只在意「清單裡有沒有 sandbox」。"""

    def verify_and_decode_signed_transaction(self, _signed):
        from appstoreserverlibrary.signed_data_verifier import (
            VerificationException, VerificationStatus,
        )
        raise VerificationException(VerificationStatus.VERIFICATION_FAILURE)


class SandboxAllowlistTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        routes.DB_PATH = os.path.join(self.tmp.name, "sandbox-allowlist.db")
        routes.JWT_SECRET = "test-only-secret"
        routes.create_aegistrans_tables()
        now = int(time.time())
        self.allowed = "user-review-account"
        self.stranger = "user-random-attacker"
        with routes.get_db() as conn:
            for uid in (self.allowed, self.stranger):
                conn.execute(
                    "INSERT INTO aegistrans_users(id,email,created_at,last_seen_at) VALUES (?,?,?,?)",
                    (uid, uid + "@example.com", now, now),
                )
                conn.execute(
                    "INSERT INTO aegistrans_sessions(sid,user_id,created_at,last_seen_at,expires_at) "
                    "VALUES (?,?,?,?,?)",
                    ("sid-" + uid, uid, now, now, now + 3600),
                )
        self.jwts = {
            uid: routes.sign_jwt({"sub": uid, "email": uid + "@example.com",
                                  "sid": "sid-" + uid, "iat": now, "exp": now + 3600})
            for uid in (self.allowed, self.stranger)
        }

        # 上線後的 production 設定：全域旗標關閉，只有審核帳號在白名單裡。
        self.orig_flag = routes.IAP_ALLOW_SANDBOX
        self.orig_allowlist = routes.IAP_SANDBOX_USER_IDS
        self.orig_get = routes._get_iap_verifiers
        routes.IAP_ALLOW_SANDBOX = False
        routes.IAP_SANDBOX_USER_IDS = frozenset({self.allowed})

        self.seen = []

        def _spy(allow_sandbox=None):
            self.seen.append(allow_sandbox)
            names = ["production"] + (["sandbox"] if allow_sandbox else [])
            return [(n, _FakeVerifier()) for n in names]

        routes._get_iap_verifiers = _spy

        app = FastAPI()
        app.include_router(routes.create_aegistrans_subscription_router())
        self.client = TestClient(app)

    def tearDown(self):
        routes.IAP_ALLOW_SANDBOX = self.orig_flag
        routes.IAP_SANDBOX_USER_IDS = self.orig_allowlist
        routes._get_iap_verifiers = self.orig_get
        self.tmp.cleanup()

    def _verify_as(self, uid):
        return self.client.post(
            "/aegistrans/subscription/verify",
            # 長度要過 model 的 min_length=20，內容不重要（fake verifier 一律驗不過）
            json={"signedTransaction": "not-a-real-jws." + "x" * 40},
            headers={"Authorization": f"Bearer {self.jwts[uid]}"},
        )

    def test_allowlisted_user_gets_sandbox_verifier(self):
        self._verify_as(self.allowed)
        self.assertEqual(self.seen, [True])

    def test_stranger_never_gets_sandbox_verifier(self):
        """核心防線：全域旗標關著時，名單外的人只能用 production 驗章。"""
        self._verify_as(self.stranger)
        self.assertEqual(self.seen, [False])

    def test_global_flag_still_overrides_for_dogfood_env(self):
        routes.IAP_ALLOW_SANDBOX = True
        self._verify_as(self.stranger)
        self.assertEqual(self.seen, [True])

    def test_env_parsing_strips_blanks(self):
        os.environ["IAP_SANDBOX_USER_IDS"] = " a , ,b,"
        parsed = frozenset(
            u.strip() for u in os.environ["IAP_SANDBOX_USER_IDS"].split(",") if u.strip()
        )
        del os.environ["IAP_SANDBOX_USER_IDS"]
        self.assertEqual(parsed, frozenset({"a", "b"}))


if __name__ == "__main__":
    unittest.main()
