"""MQTT 通行證的 ACL 不再讓人往跨帳號的 mist/broadcast 發布（稽核 B2，對應 TofuTalk 0286221 的 ACL 部分）；舊版 client
訂它不會被拒（審查 B1）。真的 router、暫存 SQLite、假寄信；不連外。

以前每個帳號的通行證都在 `all` 裡拿到 `mist/broadcast`：所有帳號共用的一條頻道，任何人都能對全世界在線的 AegisTrans
client 送任何 MessageType（`from` 自填）。AegisTrans 沒有任何正當程式用它。
現在：讀寫權限（all／pub）只在自己帳號底下：`mist/acct/{uid}/#` 與 `mist/group/aegistrans:{uid}:my-devices`。
`mist/broadcast` 只留在 `sub`（只能訂閱）：正式版 cc682d7 的 client 連上時一定會訂它（從不發布）；broker 的 deny_action
不在 repo 裡，若是 disconnect，拒絕訂閱會讓每台舊版 client 一連上就被踢（審查 B1）。誰都不能發布 → 那條頻道沒有內容。
通行證仍綁伺服器端的公鑰（sub = 伺服器重算的 pubkeyHash）。

注意：這是伺服器端修正，要等 AegisTrans API 在 AegisRD VPS 重新部署後 broker 才收得到新的 ACL。

AegisTrans 的 API 掛在 AegisTalk 的 FastAPI 行程裡，沒有獨立 app.py；這裡自己建 FastAPI 掛上 router。
Run: uv run --no-project --python 3.12 --with fastapi --with httpx --with pydantic python scripts/check-mqtt-acl.py
"""
import base64, json, os, secrets, sys, tempfile, urllib.parse
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
    assert c.post('/aegistrans/auth/email/request', json={'email': 'one@example.test', 'request_id': request_id, 'client_label': 'test'}).status_code == 200
    token = urllib.parse.parse_qs(urllib.parse.urlparse(delivered[-1]).query)['token'][0]
    assert c.post('/aegistrans/auth/email/verify', json={'token': token, 'confirmed': True}).json()['ok']
    auth = {'Authorization': 'Bearer ' + c.post('/aegistrans/auth/email/poll', json={'request_id': request_id}).json()['token']}
    key = base64.b64encode(secrets.token_bytes(32)).decode()
    r = c.post('/aegistrans/auth/devices/register', headers=auth, json={'label': 'test', 'pubkey': key, 'fingerprint_hash': secrets.token_hex(32)})
    assert r.status_code == 200, r.text
    device_id = r.json()['id']
    uid = c.get('/aegistrans/auth/me', headers=auth).json()['user']['id']

    issued = c.post('/aegistrans/auth/mqtt/token', headers=auth, json={'device_id': device_id, 'pubkeyHash': routes.pubkey_hash(key)})
    assert issued.status_code == 200, issued.text
    payload = issued.json()['token'].split('.')[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
    acl = claims['acl']
    assert claims['sub'] == routes.pubkey_hash(key)
    writable = acl['all'] + acl.get('pub', [])
    assert not any(t in ('mist/broadcast', '#', 'mist/#') or t.startswith('mist/broadcast') for t in writable), \
        f'nobody can publish on the cross-account mist/broadcast topic (got {acl})'
    own = (f'mist/acct/{uid}/', f'mist/group/aegistrans:{uid}:')
    assert all(t.startswith(own) for t in writable), f'read/write grants stay inside the account (got {acl})'
    assert acl['all'] == [f'mist/acct/{uid}/#', f'mist/group/aegistrans:{uid}:my-devices']
    assert acl.get('pub', []) == []
    print('PASS MQTT token grants read/write only inside the account (no publish on the global mist/broadcast)')

    # 審查 B1：舊版（cc682d7）連上時訂 mist/broadcast；broker 的 deny_action 不在 repo 裡，拒絕訂閱可能把它踢掉。
    assert 'mist/broadcast' in acl.get('sub', []), f'old clients can still subscribe to mist/broadcast (subscribe-only, got {acl})'
    assert acl['sub'] == ['aegis/device/+/kicked', 'mist/broadcast'], acl['sub']
    print('PASS mist/broadcast stays subscribe-only, so an old client subscribing to it is never denied (or disconnected)')
