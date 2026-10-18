"""660fdbb 之後的裝置上限畫面（AegisTrans 審查 G；對應 TofuTalk dd36777）。真的 router、暫存 SQLite、假寄信；不連外。

- 409 帶上這個 session 綁定的那台（current_device_id），畫面才能把它標成「本機」（撤銷它＝撤銷正在註冊的這個 session）。
- 同指紋、還沒有公鑰的那筆（舊版用戶端註冊時沒帶公鑰）照舊就地補上公鑰，跟舊伺服器一樣；660fdbb 起這種安裝會多一筆，
  免費版（2 台）帳號滿了就跳出上限畫面（審查的 probe_migration 情境 1）。公鑰不同的同指紋那筆照舊不碰（稽核 B4，
  scripts/check-device-fingerprint.py）。
- 帳號裡已經有一筆帶這把公鑰時（同一個安裝、指紋變了），沒有公鑰的那筆不補，往下走同公鑰去重回那一筆（審查 round-3
  MEDIUM-3，對應 TofuTalk af1a481）：不會有兩筆同公鑰，撤銷看得到的那筆就真的撤銷。

AegisTrans 的 API 掛在 AegisTalk 的 FastAPI 行程裡，沒有獨立 app.py；這裡自己建 FastAPI 掛上 router。
Run: uv run --no-project --python 3.12 --with fastapi --with httpx --with pydantic python scripts/check-device-limit-gate.py
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
        return {'Authorization': 'Bearer ' + c.post('/aegistrans/auth/email/poll', json={'request_id': rid}).json()['token']}

    def key():
        return base64.b64encode(secrets.token_bytes(32)).decode()

    def register(auth, pubkey, fingerprint):
        return c.post('/aegistrans/auth/devices/register', headers=auth,
                      json={'label': 'x', 'pubkey': pubkey, 'fingerprint_hash': fingerprint})

    def user_id(email):
        with routes.get_db() as db:
            return db.execute('SELECT id FROM aegistrans_users WHERE email=?', (email,)).fetchone()['id']

    def insert_keyless(email, row_id, fp):
        with routes.get_db() as db:
            db.execute('INSERT INTO aegistrans_devices (id, user_id, label, user_agent, pubkey, fingerprint_hash, first_seen_at, last_seen_at) '
                       'VALUES (?,?,?,?,?,?,?,?)', (row_id, user_id(email), 'old', '', None, fp, 1, 1))

    failures = []

    def check(name, fn):
        try:
            fn()
            print(f'PASS {name}')
        except AssertionError as e:
            failures.append(name)
            print(f'FAIL {name}\n     {str(e).splitlines()[0] if str(e) else "assertion failed"}')

    def bound_device_in_409():
        auth = login('full@example.test')
        others = login('full@example.test')              # 同帳號另一個 session
        assert register(others, key(), secrets.token_hex(32)).status_code == 200
        mine = register(auth, key(), secrets.token_hex(32))
        assert mine.status_code == 200
        my_id = mine.json()['id']                          # 免費版 2 台：滿了
        r = register(auth, key(), secrets.token_hex(32))   # 這個安裝的身分換了：算「新」裝置
        assert r.status_code == 409, r.status_code
        detail = r.json()['detail']
        assert detail.get('current_device_id') == my_id, f"current_device_id={detail.get('current_device_id')} want {my_id}"
        assert my_id in [dev['id'] for dev in detail['devices']]
        fresh = login('full@example.test')                # 還沒綁任何裝置的新 session
        r2 = register(fresh, key(), secrets.token_hex(32))
        assert r2.status_code == 409 and r2.json()['detail'].get('current_device_id') is None, r2.json()
    check('the 409 device-limit answer names the device this session is bound to', bound_device_in_409)

    def keyless_row_upgraded():
        auth = login('legacy@example.test')
        fp = secrets.token_hex(32)
        insert_keyless('legacy@example.test', 'legacy-row', fp)
        pk = key()
        r = register(auth, pk, fp)
        assert r.status_code == 200, r.status_code
        assert r.json()['id'] == 'legacy-row', f"got a new row {r.json()['id']} instead of upgrading the keyless one"
        with routes.get_db() as db:
            rows = db.execute('SELECT id, pubkey FROM aegistrans_devices WHERE user_id=?', (user_id('legacy@example.test'),)).fetchall()
        assert [(row['id'], row['pubkey']) for row in rows] == [('legacy-row', pk)], [tuple(row) for row in rows]
        r2 = register(auth, key(), fp)                     # 同指紋、那筆現在有別的公鑰 → 另一台
        assert r2.status_code == 200 and r2.json()['id'] != 'legacy-row'
    check('a same-fingerprint row without a pubkey (old client) is upgraded in place, not duplicated', keyless_row_upgraded)

    def keyless_row_when_full():
        auth = login('legacyfull@example.test')
        phone = login('legacyfull@example.test')
        fp = secrets.token_hex(32)
        insert_keyless('legacyfull@example.test', 'legacy-full', fp)
        assert register(phone, key(), secrets.token_hex(32)).status_code == 200   # 免費版 2 台：滿了
        r = register(auth, key(), fp)
        assert r.status_code == 200 and r.json()['id'] == 'legacy-full', \
            f'{r.status_code}: the full account answered 409 instead of the in-place upgrade'
    check('with the free account full, the keyless row is still upgraded (no device-limit screen)', keyless_row_when_full)

    # 審查 round-3 MEDIUM-3（對應 TofuTalk af1a481；4c00206）：就地補公鑰在「同公鑰去重」（Step 2）之前跑。帳號裡已經有一筆
    # 帶這把公鑰（同一個安裝、指紋變了）時，沒有公鑰的那筆也被補上同一把 → 兩筆同公鑰；撤銷畫面上那筆後，另一筆還帶著它，
    # session 綁在另一筆上也照樣有效。
    def keyless_row_not_given_a_taken_pubkey():
        auth = login('dup@example.test')
        other = login('dup@example.test')
        pk, f1, f2 = key(), secrets.token_hex(32), secrets.token_hex(32)
        r1 = register(auth, pk, f1)
        assert r1.status_code == 200, r1.status_code
        mine = r1.json()['id']
        insert_keyless('dup@example.test', 'keyless-dup', f2)
        r2 = register(auth, pk, f2)                    # 同一個安裝，指紋變了；舊用戶端留下的那筆正好是這個指紋
        assert r2.status_code == 200 and r2.json()['id'] == mine, f"answered {r2.json()['id']} instead of {mine}, the row that has this pubkey"
        with routes.get_db() as db:
            rows = db.execute('SELECT id FROM aegistrans_devices WHERE user_id=? AND pubkey=?', (user_id('dup@example.test'), pk)).fetchall()
        assert [row['id'] for row in rows] == [mine], f'{len(rows)} rows carry this pubkey: {[row["id"] for row in rows]}'
        assert c.delete(f'/aegistrans/auth/devices/{mine}', headers=other).status_code == 200
        listed = [dev.get('pubkey') for dev in c.get('/aegistrans/auth/devices', headers=other).json()['devices']]
        assert pk not in listed, 'the pubkey is still on the account after revoking its device'
        assert c.get('/aegistrans/auth/devices', headers=auth).status_code == 401, "the revoked device's session still works"
    check('a keyless row is not given a pubkey another row of the account already has (no duplicate; revocation holds)', keyless_row_not_given_a_taken_pubkey)

    if failures:
        print(f'\n{len(failures)} check(s) failed')
        sys.exit(1)
    print('\nall device-limit gate API checks passed')
