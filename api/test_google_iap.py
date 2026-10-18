"""Small runnable regression check for the Google Play entitlement trust boundary."""
import os
import tempfile
import time
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

import _test_env

_test_env.apply()
import aegistrans_routes as routes  # noqa: E402


class GoogleIapTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        routes.DB_PATH = os.path.join(self.tmp.name, "iap-test.db")
        routes.JWT_SECRET = "test-only-secret"
        routes.create_aegistrans_tables()
        now = int(time.time())
        self.user_id = "user-iap-test"
        self.sid = "sid-iap-test"
        with routes.get_db() as conn:
            conn.execute(
                "INSERT INTO aegistrans_users(id,email,created_at,last_seen_at) VALUES (?,?,?,?)",
                (self.user_id, "iap@example.com", now, now),
            )
            conn.execute(
                "INSERT INTO aegistrans_sessions(sid,user_id,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?)",
                (self.sid, self.user_id, now, now, now + 3600),
            )
        self.jwt = routes.sign_jwt({
            "sub": self.user_id, "email": "iap@example.com", "sid": self.sid,
            "iat": now, "exp": now + 3600,
        })
        self.calls = []
        self.original_request = routes._google_play_request

        def fake_request(method, path):
            self.calls.append((method, path))
            if method == "POST":
                return {}
            return {
                "subscriptionState": "SUBSCRIPTION_STATE_ACTIVE",
                "acknowledgementState": "ACKNOWLEDGEMENT_STATE_PENDING",
                "externalAccountIdentifiers": {
                    "obfuscatedExternalAccountId": routes._expected_app_account_token(self.user_id),
                },
                "lineItems": [{
                    "productId": "com.aegisrd.aegistrans.pro.monthly",
                    "expiryTime": "2099-01-01T00:00:00Z",
                }],
            }

        routes._google_play_request = fake_request
        app = FastAPI()
        app.include_router(routes.create_aegistrans_router())
        app.include_router(routes.create_aegistrans_subscription_router())
        self.client = TestClient(app)

    def tearDown(self):
        routes._google_play_request = self.original_request
        self.tmp.cleanup()

    def test_active_purchase_is_verified_bound_stored_then_acknowledged(self):
        response = self.client.post(
            "/aegistrans/subscription/verify-google",
            headers={"Authorization": f"Bearer {self.jwt}"},
            json={
                "productId": "com.aegisrd.aegistrans.pro.monthly",
                "purchaseToken": "valid-test-purchase-token-123456",
                "productType": "subs",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["tier"], "pro_monthly")
        self.assertEqual([method for method, _ in self.calls], ["GET", "POST"])
        with routes.get_db() as conn:
            row = conn.execute("SELECT tier,source FROM aegistrans_licenses WHERE user_id=?", (self.user_id,)).fetchone()
        self.assertEqual((row["tier"], row["source"]), ("pro_monthly", "google"))

    def test_purchase_from_another_account_is_rejected(self):
        original = routes._google_play_request

        def wrong_account(method, path):
            result = original(method, path)
            if method == "GET":
                result["externalAccountIdentifiers"]["obfuscatedExternalAccountId"] = "00000000-0000-0000-0000-000000000000"
            return result

        routes._google_play_request = wrong_account
        response = self.client.post(
            "/aegistrans/subscription/verify-google",
            headers={"Authorization": f"Bearer {self.jwt}"},
            json={
                "productId": "com.aegisrd.aegistrans.pro.monthly",
                "purchaseToken": "another-account-purchase-token-123",
                "productType": "subs",
            },
        )
        self.assertEqual(response.status_code, 403, response.text)
        with routes.get_db() as conn:
            count = conn.execute("SELECT COUNT(*) FROM aegistrans_licenses").fetchone()[0]
        self.assertEqual(count, 0)

    def test_account_deletion_removes_purchase_binding(self):
        now = int(time.time())
        with routes.get_db() as conn:
            conn.execute(
                "INSERT INTO aegistrans_licenses(user_id,tier,source,external_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
                (self.user_id, "pro_lifetime", "google", "google-test-binding", now, now),
            )
        response = self.client.delete(
            "/aegistrans/auth/users/me",
            headers={"Authorization": f"Bearer {self.jwt}"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        with routes.get_db() as conn:
            remaining = {
                table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in ("aegistrans_users", "aegistrans_sessions", "aegistrans_licenses")
            }
        self.assertEqual(remaining, {table: 0 for table in remaining})


if __name__ == "__main__":
    unittest.main()
