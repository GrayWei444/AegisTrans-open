"""硬體指紋相同的兩台裝置不能合併成一筆（稽核 B4，對應 TofuTalk d442919）。真的 router、暫存 SQLite、假寄信；不連外。

以前指紋相同、公鑰不同時，只要舊那筆的 last_seen 超過 90 秒就把它的公鑰覆蓋掉；last_seen 只在註冊／開機時更新，
使用中的裝置幾乎都超過 90 秒。指紋只有 CPU 核心數、記憶體、平台名稱（設計上同一台機器的各瀏覽器都相同；Safari 沒有
記憶體，iPad 回報 MacIntel），Mac 上的 Chrome 和 Safari、或 Mac 與 iPad 的 Safari 很容易同指紋 → 兩台拿到同一個裝置 id：
彼此的訊息被當成「自己的」丟掉、前一台下次換 MQTT token 被拒（pubkeyHash 不符）、撤銷「一台」等於撤銷兩台。
現在：指紋只用來認「同一個安裝」（指紋＋公鑰都相同）；公鑰不同就是另一台，新增一筆（受 tier 上限）。

AegisTrans 的 API 掛在 AegisTalk 的 FastAPI 行程裡，沒有獨立 app.py；這裡自己建 FastAPI 掛上 router。
Run: uv run --no-project --python 3.12 --with fastapi --with httpx --with pydantic python scripts/check-device-fingerprint.py
"""
import os, secrets, sys, tempfile, time, urllib.parse
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

    def register(auth, pubkey, fp):
        r = c.post('/aegistrans/auth/devices/register', headers=auth, json={'label': 'x', 'pubkey': pubkey, 'fingerprint_hash': fp})
        assert r.status_code == 200, (r.status_code, r.text)
        return r.json()

    def age_all():  # 模擬「已經開著一陣子」：last_seen 只在註冊／開機更新
        with routes.get_db() as db:
            db.execute('UPDATE aegistrans_devices SET last_seen_at=?', (int(time.time()) - 3600,))

    fp = 'f' * 64
    chrome = login('owner@example.test')
    safari = login('owner@example.test')
    a = register(chrome, 'PUBKEY_MAC_CHROME_' + 'A' * 26, fp)
    age_all()
    b = register(safari, 'PUBKEY_MAC_SAFARI_' + 'B' * 26, fp)
    assert b['id'] != a['id'], 'a second install with the same fingerprint gets its own device id'
    devices = {x['id']: x['pubkey'] for x in c.get('/aegistrans/auth/devices', headers=chrome).json()['devices']}
    assert devices[a['id']].startswith('PUBKEY_MAC_CHROME'), 'the first device keeps its own pubkey'
    assert devices[b['id']].startswith('PUBKEY_MAC_SAFARI')
    print('PASS same-fingerprint devices stay separate (no pubkey overwrite, no shared device id)')

    age_all()
    again = register(chrome, 'PUBKEY_MAC_CHROME_' + 'A' * 26, fp)
    assert again['id'] == a['id'], 'the same install (fingerprint + pubkey) still maps to its own row'
    assert len(c.get('/aegistrans/auth/devices', headers=chrome).json()['devices']) == 2
    print('PASS re-registering the same install reuses its row')
