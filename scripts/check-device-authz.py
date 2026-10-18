"""一台裝置的登入不能替別台裝置改公鑰或申請 MQTT 通行證（稽核 B20，對應 TofuTalk 0b28cdc）。真的 router、暫存 SQLite、
假寄信；不連外。

以前只檢查「是不是這個帳號」：任何一台已登入的裝置（或偷到它 session 的人）都能
  - PUT /devices/{別台}/pubkey 把別台的公鑰換成自己的 → 其他裝置改跟這把金鑰配對；
  - POST /mqtt/token 帶別台的 device_id 拿到別台的 broker 通行證。
現在：session 綁定了哪台裝置（register 時綁定，CR-01），就只能動那一台。撤銷別台維持可以（裝置管理功能）。

AegisTrans 的 API 掛在 AegisTalk 的 FastAPI 行程裡，沒有獨立 app.py；這裡自己建 FastAPI 掛上 router。
Run: uv run --no-project --python 3.12 --with fastapi --with httpx --with pydantic python scripts/check-device-authz.py
"""
import os, secrets, sys, tempfile, urllib.parse
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

    def login(email):
        with routes.get_db() as db:
            db.execute('UPDATE aegistrans_magic_tokens SET created_at=0')   # 跳過同 email 60 秒節流
        request_id = secrets.token_hex(24)
        assert c.post('/aegistrans/auth/email/request', json={'email': email, 'request_id': request_id, 'client_label': 'test'}).status_code == 200
        token = urllib.parse.parse_qs(urllib.parse.urlparse(delivered[-1]).query)['token'][0]
        assert c.post('/aegistrans/auth/email/verify', json={'token': token, 'confirmed': True}).json()['ok']
        return {'Authorization': 'Bearer ' + c.post('/aegistrans/auth/email/poll', json={'request_id': request_id}).json()['token']}

    def register(auth, pubkey):
        r = c.post('/aegistrans/auth/devices/register', headers=auth, json={'label': 'x', 'pubkey': pubkey, 'fingerprint_hash': secrets.token_hex(32)})
        assert r.status_code == 200, r.text
        return r.json()['id']

    mac = login('owner@example.test')
    ipad = login('owner@example.test')
    pk_mac = 'M' * 43 + '='
    pk_ipad = 'I' * 43 + '='
    dm = register(mac, pk_mac)
    di = register(ipad, pk_ipad)

    r = c.put(f'/aegistrans/auth/devices/{di}/pubkey', headers=mac, json={'pubkey': 'X' * 43 + '='})
    assert r.status_code == 403, ('cannot replace another device pubkey', r.status_code)
    assert c.put(f'/aegistrans/auth/devices/{dm}/pubkey', headers=mac, json={'pubkey': pk_mac}).status_code == 200, 'can update its own'
    devices = {x['id']: x['pubkey'] for x in c.get('/aegistrans/auth/devices', headers=mac).json()['devices']}
    assert devices[di] == pk_ipad
    print('PASS a session can only change its own device pubkey')

    def token(auth, device_id, pubkey):
        return c.post('/aegistrans/auth/mqtt/token', headers=auth, json={'pubkeyHash': routes.pubkey_hash(pubkey), 'device_id': device_id})

    r = token(mac, di, pk_ipad)
    assert r.status_code == 403, ('cannot mint a broker token for another device', r.status_code)
    assert token(mac, dm, pk_mac).status_code == 200, 'can mint its own'
    print('PASS a session can only get a broker token for its own device')

    assert c.delete(f'/aegistrans/auth/devices/{di}', headers=mac).status_code == 200, 'revoking another device stays allowed'
    print('PASS revoking another device is still allowed (device management)')
