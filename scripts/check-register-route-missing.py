"""共用 API 行程沒掛上 aegistrans 路由時，register 拿到的回答（AegisTrans 審查 M3）。真的 router、暫存 SQLite；不連外。

aegistrans 路由掛在 AegisTalk 的 FastAPI 行程裡（AegisTalk api/main.py：aegistrans_routes.py 匯入失敗 → _HAS_AEGISTRANS=False，
整組不掛）。那時 POST /aegistrans/auth/devices/register 回 FastAPI 的 404 {"detail":"Not Found"}；掛上時 register 對各種
輸入都不回 404。App（auth.ts registerFailure）把這個 404 當成暫時性（network，退避重試），不停在「無法完成註冊」；
scripts/check-register-errors.mjs 餵的就是這個回答。

Run: uv run --no-project --python 3.12 --with fastapi --with httpx --with pydantic python scripts/check-register-route-missing.py
"""
import base64, os, secrets, sys, tempfile, urllib.parse
from pathlib import Path

with tempfile.TemporaryDirectory() as d:
    os.environ['AEGIS_DB_PATH'] = d + '/test.db'
    os.environ['AEGISTRANS_JWT_SECRET'] = secrets.token_hex(32)
    os.environ['AEGIS_MQTT_JWT_SECRET'] = secrets.token_hex(32)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import aegistrans_routes as routes

    body = {'label': 'x', 'pubkey': base64.b64encode(secrets.token_bytes(32)).decode(), 'fingerprint_hash': 'f' * 64}
    bare = TestClient(FastAPI())   # 共用行程沒掛上 aegistrans 路由
    r = bare.post('/aegistrans/auth/devices/register', headers={'Authorization': 'Bearer x'}, json=body)
    assert (r.status_code, r.json()) == (404, {'detail': 'Not Found'}), (r.status_code, r.text)
    print('PASS without the aegistrans routes, register answers 404 {"detail":"Not Found"}')

    delivered = []
    routes.send_magic_link_email = lambda email, url: delivered.append(url) or True
    app = FastAPI()
    app.include_router(routes.create_aegistrans_router())
    c = TestClient(app)
    request_id = secrets.token_hex(24)
    assert c.post('/aegistrans/auth/email/request', json={'email': 'm3@example.test', 'request_id': request_id, 'client_label': 't'}).status_code == 200
    token = urllib.parse.parse_qs(urllib.parse.urlparse(delivered[-1]).query)['token'][0]
    assert c.post('/aegistrans/auth/email/verify', json={'token': token, 'confirmed': True}).json()['ok']
    auth = {'Authorization': 'Bearer ' + c.post('/aegistrans/auth/email/poll', json={'request_id': request_id}).json()['token']}
    answers = [
        c.post('/aegistrans/auth/devices/register', headers=auth, json=body),                        # 新裝置
        c.post('/aegistrans/auth/devices/register', headers=auth, json=body),                        # 同一台再註冊
        c.post('/aegistrans/auth/devices/register', headers=auth, json={**body, 'pubkey': None}),     # 沒帶公鑰
        c.post('/aegistrans/auth/devices/register', headers=auth, json={'label': 'x'}),               # 沒帶指紋
        c.post('/aegistrans/auth/devices/register', headers=auth, json={**body, 'pubkey': 'Q' * 43 + '=', 'fingerprint_hash': 'g' * 64}),  # 超過免費版上限
        c.post('/aegistrans/auth/devices/register', headers=auth, json={}),                          # 欄位錯誤
        c.post('/aegistrans/auth/devices/register', headers={'Authorization': 'Bearer bad'}, json=body),
    ]
    assert all(a.status_code != 404 for a in answers), [(a.status_code, a.text[:80]) for a in answers]
    print('PASS with the routes mounted, register never answers 404 (statuses: %s)' % sorted({a.status_code for a in answers}))
