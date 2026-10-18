"""只有真的刪掉的帳號才回「Account no longer exists」（AegisTrans 審查 F；對應 TofuTalk 50efc62）。真的 router、暫存 SQLite、
假寄信；不連外。

401 "Account no longer exists" 是用戶端的撤銷答案之一（會登出）。API 連到錯的或空的資料庫啟動時（部署出錯、還原到錯的
路徑；aegistrans 路由跟 AegisTalk 共用同一個行程與 SQLite 檔），每個請求都找不到帳號 → 每個開著的 App 都收到這個答案、
一起被登出。用戶端分不出來（空資料庫每次檢查都回同一個答案），所以伺服器只在刪帳號端點留下墓碑時才回這個答案；
帳號不見又沒有墓碑 → 503（用戶端照 5xx 規則當成暫時性錯誤、保留登入）。墓碑表 aegistrans_deleted_users 是 aegistrans
自己的表（只有隨機帳號 id 與時間），不碰共用行程裡 AegisTalk 的表。

AegisTrans 的 API 掛在 AegisTalk 的 FastAPI 行程裡，沒有獨立 app.py；這裡自己建 FastAPI 掛上 router。
Run: uv run --no-project --python 3.12 --with fastapi --with httpx --with pydantic python scripts/check-account-tombstone.py
"""
import base64, os, secrets, sqlite3, sys, tempfile, time, urllib.parse
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
        rid = secrets.token_hex(24)
        assert c.post('/aegistrans/auth/email/request', json={'email': email, 'request_id': rid, 'client_label': 't'}).status_code == 200
        tok = urllib.parse.parse_qs(urllib.parse.urlparse(delivered[-1]).query)['token'][0]
        assert c.post('/aegistrans/auth/email/verify', json={'token': tok, 'confirmed': True}).json()['ok']
        auth = {'Authorization': 'Bearer ' + c.post('/aegistrans/auth/email/poll', json={'request_id': rid}).json()['token']}
        body = {'label': 'x', 'pubkey': base64.b64encode(secrets.token_bytes(32)).decode(), 'fingerprint_hash': secrets.token_hex(32)}
        assert c.post('/aegistrans/auth/devices/register', headers=auth, json=body).status_code == 200
        return auth

    failures = []

    def check(name, fn):
        try:
            fn()
            print(f'PASS {name}')
        except (AssertionError, sqlite3.Error) as e:
            failures.append(name)
            print(f'FAIL {name}\n     {str(e).splitlines()[0] if str(e) else "assertion failed"}')

    deleted = login('gone@example.test')
    kept = login('kept@example.test')

    def deleted_account():
        assert c.delete('/aegistrans/auth/users/me', headers=deleted).json()['ok']
        r = c.get('/aegistrans/auth/devices', headers=deleted)
        assert (r.status_code, r.json()) == (401, {'detail': 'Account no longer exists'}), (r.status_code, r.json())
        assert c.get('/aegistrans/auth/devices', headers=kept).status_code == 200
    check('a really deleted account still gets 401 "Account no longer exists" (clients sign out)', deleted_account)

    def missing_without_tombstone():
        with routes.get_db() as db:   # 帳號列不是經由刪帳號端點不見的（部分還原、手動改資料庫）
            uid = db.execute("SELECT id FROM aegistrans_users WHERE email='kept@example.test'").fetchone()['id']
            db.execute('DELETE FROM aegistrans_users WHERE id=?', (uid,))
        for name, r in [('GET /devices', c.get('/aegistrans/auth/devices', headers=kept)),
                        ('POST mqtt/token', c.post('/aegistrans/auth/mqtt/token', headers=kept, json={'device_id': 'x', 'pubkeyHash': 'y' * 32}))]:
            assert r.status_code == 503, f'{name}: {r.status_code} {r.json()}'
            assert r.json().get('detail') != 'Account no longer exists'
    check('an account missing without a tombstone is 503, not a revocation answer', missing_without_tombstone)

    def empty_database():
        survivor = login('survivor@example.test')
        real_path = routes.DB_PATH
        routes.DB_PATH = d + '/empty.db'       # 共用行程重開時連到錯的／空的資料庫
        routes.create_aegistrans_tables()
        try:
            for name, r in [('GET /devices', c.get('/aegistrans/auth/devices', headers=survivor)),
                            ('POST register', c.post('/aegistrans/auth/devices/register', headers=survivor,
                                                     json={'label': 'x', 'pubkey': 'Q' * 43 + '=', 'fingerprint_hash': 'e' * 64})),
                            ('POST ping', c.post('/aegistrans/auth/devices/whatever/ping', headers=survivor))]:
                assert r.status_code == 503, f'{name}: {r.status_code} {r.json()}'
        finally:
            routes.DB_PATH = real_path
        assert c.get('/aegistrans/auth/devices', headers=survivor).status_code == 200, 'back on the right database: works again'
    check('an API started against an empty database answers 503 for everyone (nobody is signed out)', empty_database)

    def tombstones_pruned():
        with routes.get_db() as db:
            db.execute('INSERT OR REPLACE INTO aegistrans_deleted_users (id, deleted_at) VALUES (?, ?)',
                       ('ancient', int(time.time()) - routes.SESSION_TTL_SECONDS - 10))
        doomed = login('doomed@example.test')
        assert c.delete('/aegistrans/auth/users/me', headers=doomed).json()['ok']
        with routes.get_db() as db:
            rows = [dict(row) for row in db.execute('SELECT * FROM aegistrans_deleted_users')]
        ids = {row['id'] for row in rows}
        assert 'ancient' not in ids, 'tombstones older than the session lifetime are pruned (every JWT of that account has expired)'
        assert len(ids) == 2, ids
        assert all(set(row) == {'id', 'deleted_at'} for row in rows), f'only the random account id and the time are kept: {rows}'
    check('tombstones keep only the random account id and are pruned after the session lifetime', tombstones_pruned)

    def own_table_only():
        with routes.get_db() as db:
            tables = {row['name'] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert 'aegistrans_deleted_users' in tables
        assert all(t.startswith('aegistrans_') for t in tables), f'the router only creates its own aegistrans_* tables: {sorted(tables)}'
    check('the tombstone lives in an aegistrans_* table (the SQLite file is shared with AegisTalk)', own_table_only)

    if failures:
        print(f'\n{len(failures)} check(s) failed')
        sys.exit(1)
    print('\nall account tombstone checks passed')
