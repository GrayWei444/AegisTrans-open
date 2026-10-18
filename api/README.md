# AegisTrans API

FastAPI routers for e-mail sign-in, "my devices", MQTT tokens and subscription state.
Storage is a single SQLite file; tables are prefixed `aegistrans_`.

Two ways to run it:

- **Standalone (self-hosting):** `api/app.py` — `uvicorn app:create_app --factory`.
  Every setting comes from environment variables, listed in `api/.env.example`.
  See `docs/SELF_HOSTING.md` for the broker, reverse proxy and app configuration.
- **Embedded:** mount `create_aegistrans_router()` and
  `create_aegistrans_subscription_router()` into an existing FastAPI app.

```bash
pip install -r requirements.txt
cp .env.example .env   # fill in, then export the variables
uvicorn app:create_app --factory --port 8000
```

Tests: `python -m unittest test_schema_b test_google_iap test_iap_sandbox_allowlist`
(from this directory), plus `scripts/check-*.py` at the repository root.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/aegistrans/auth/server-config` | Public connection details for clients that switch to this server |
| POST | `/aegistrans/auth/email/request` | Send a sign-in / verification link (rate limited) |
| POST | `/aegistrans/auth/email/verify` | Called by the page the link opens; two steps (`confirmed=false` shows who asked, `confirmed=true` verifies) |
| POST | `/aegistrans/auth/email/poll` | The requesting device polls; returns a session JWT once verified |
| GET | `/aegistrans/auth/me` | Current user (Bearer JWT) |
| POST | `/aegistrans/auth/password/login` | E-mail + password sign-in (scrypt) |
| POST | `/aegistrans/auth/password/set` | Set / change password (`current_password` required to change) |
| GET | `/aegistrans/auth/password/status` | Whether a password is set |
| POST | `/aegistrans/auth/mqtt/token` | MQTT broker token bound to a registered device's public key |
| POST | `/aegistrans/auth/devices/register` | Register this device (deduplicated by `fingerprint_hash`) |
| PUT | `/aegistrans/auth/devices/{id}/pubkey` | Update a device's public key |
| GET | `/aegistrans/auth/devices` | List my devices |
| POST | `/aegistrans/auth/devices/{id}/ping` | Heartbeat |
| DELETE | `/aegistrans/auth/devices/{id}` | Revoke a device |
| DELETE | `/aegistrans/auth/users/me` | Delete the account |
| GET | `/aegistrans/subscription/status` | Current tier |
| POST | `/aegistrans/subscription/verify`, `/verify-google` | In-app purchase verification (503 unless configured) |
| POST | `/aegistrans/subscription/apple-notifications`, `/google-notifications` | Store server notifications (503 unless configured) |
| POST | `/aegistrans/subscription/dev-set-tier` | Development only (`AEGISTRANS_DEV_MODE=1` + admin e-mail) |

`aegistrans_routes.py` is the source of truth for request/response shapes.

## Tables

- `aegistrans_users (id, email, created_at, last_seen_at, password_hash)` — `password_hash` 為 `scrypt$<salt>$<hash>`（per-user salt，無明文）
- `aegistrans_magic_tokens (token, email, created_at, expires_at, used_at, request_id, verified_at, client_label)`
- `aegistrans_devices (id, user_id, label, user_agent, pubkey, fingerprint_hash, first_seen_at, last_seen_at)` — 依 `fingerprint_hash` 去重（1 硬體 1 row）
- `aegistrans_licenses (user_id, tier, source, expires_at, external_id, created_at, updated_at)` — Phase 1A.1

