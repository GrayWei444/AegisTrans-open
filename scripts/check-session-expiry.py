"""Session 到期後伺服器的回答（對應 TofuTalk 749e349，審查 HIGH-1）。真的 router、暫存 SQLite、假寄信；不連外。

JWT 的 exp 就是 session 的到期時間，verify_jwt 在查 session 之前就擋掉過期的 JWT，所以過了 SESSION_TTL_SECONDS 之後
每個要登入的端點都回 401 "Invalid or expired token"——跟部署出錯的 JWT secret 同一個回答，也不是 App 的撤銷回答之一。
所以 App 要看 session 自己的效期判斷「到期」（auth.ts isSessionExpired；scripts/check-session-expiry.mjs 餵的就是這個回答）。

AegisTrans 的 API 掛在 AegisTalk 的 FastAPI 行程裡，沒有獨立 app.py；這裡自己建 FastAPI 掛上 router。
Run: uv run --no-project --python 3.12 --with fastapi --with httpx --with pydantic python scripts/check-session-expiry.py
"""
import base64, json, os, secrets, sys, tempfile, time, urllib.parse
from pathlib import Path

with tempfile.TemporaryDirectory() as d:
    os.environ['AEGIS_DB_PATH'] = d + '/test.db'
    os.environ['AEGISTRANS_JWT_SECRET'] = secrets.token_hex(32)
    os.environ['AEGIS_MQTT_JWT_SECRET'] = secrets.token_hex(32)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import aegistrans_routes as routes

    delivered = []
    routes.send_magic_link_email = lambda email, url: delivered.append(url) or True
    app = FastAPI()
    app.include_router(routes.create_aegistrans_router())
    c = TestClient(app)

    request_id = secrets.token_hex(24)
    assert c.post('/aegistrans/auth/email/request', json={'email': 'o@example.test', 'request_id': request_id, 'client_label': 't'}).status_code == 200
    token = urllib.parse.parse_qs(urllib.parse.urlparse(delivered[-1]).query)['token'][0]
    assert c.post('/aegistrans/auth/email/verify', json={'token': token, 'confirmed': True}).json()['ok']
    jwt = c.post('/aegistrans/auth/email/poll', json={'request_id': request_id}).json()['token']
    auth = {'Authorization': 'Bearer ' + jwt}
    pubkey = base64.b64encode(secrets.token_bytes(32)).decode()
    body = {'label': 'x', 'pubkey': pubkey, 'fingerprint_hash': 'f' * 64}
    r = c.post('/aegistrans/auth/devices/register', headers=auth, json=body)
    assert r.status_code == 200, r.text
    dev = r.json()['id']

    payload = json.loads(base64.urlsafe_b64decode(jwt.split('.')[1] + '=='))
    with routes.get_db() as db:
        expires_at = db.execute('SELECT expires_at FROM aegistrans_sessions WHERE sid=?', (payload['sid'],)).fetchone()['expires_at']
    assert payload['exp'] == expires_at, f"the JWT exp ({payload['exp']}) is the session expiry ({expires_at})"
    assert c.get('/aegistrans/auth/devices', headers=auth).status_code == 200

    real = time.time
    time.time = lambda: real() + routes.SESSION_TTL_SECONDS + 60   # 30 天後：JWT exp 與 session 效期都過了
    try:
        answers = {
            'GET /devices': c.get('/aegistrans/auth/devices', headers=auth),
            'POST ping': c.post(f'/aegistrans/auth/devices/{dev}/ping', headers=auth),
            'POST register': c.post('/aegistrans/auth/devices/register', headers=auth, json=body),
            'POST mqtt/token': c.post('/aegistrans/auth/mqtt/token', headers=auth,
                                      json={'device_id': dev, 'pubkeyHash': routes.pubkey_hash(pubkey)}),
        }
    finally:
        time.time = real
    revocation_details = {'Device revoked', 'Session revoked or expired', 'Account no longer exists',
                          'Legacy session; please sign in again', 'Device not found'}
    for name, r in answers.items():
        assert r.status_code == 401, f'{name}: {r.status_code}'
        assert r.json() == {'detail': 'Invalid or expired token'}, f'{name}: {r.json()}'
        assert r.json()['detail'] not in revocation_details, f'{name}: answered like a revocation'
print('PASS after the session TTL every endpoint answers 401 "Invalid or expired token" (not a revocation answer)')
