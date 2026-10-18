/**
 * 自動登出只認 API 自己的「已撤銷」回應；開著的 App 也會登出，但要連續兩次（對應 TofuTalk 96a54d7 + 7c7251e，
 * 審查 MEDIUM-2）：真的 services/auth.ts ＋ 真的 hooks/useAuth.ts（esbuild；React、指紋、金鑰、本機資料清除 stub 掉）。
 *   以前（af4ffb1）冷啟動把任何 401/403/404 都當成「這台被撤銷」→ 一次出錯的 API 部署（JWT secret 設錯 → 401
 *   "Invalid or expired token"）、反向代理或共用 AegisTalk 行程沒掛上 aegistrans 路由（404 "Not Found"）會把
 *   使用者登出；而開著的 App 被撤銷後一直停在登入狀態（MQTT 踢裝置訊號沒有發送端、也沒人聽）。
 *   現在：只有 api/aegistrans_routes.py 自己的撤銷回應才算（401 "Device revoked"／"Session revoked or expired"／
 *   "Account no longer exists"／"Legacy session; please sign in again"、ping 的 404 "Device not found"）；
 *   每 20 秒的清單刷新失敗時 ping 這台，連續兩次都是撤銷回應才登出（中間任何一次不是就重新計算）。
 *   冷啟動一次即可（scripts/check-cold-start-signout.mjs）。
 * Run: node scripts/check-auth-revocation.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => join(root, 'packages/pwa/src', p);
const require = createRequire(join(root, 'packages/pwa/package.json'));
const dir = mkdtempSync(join(tmpdir(), 'authrev-'));
const SESSION_KEY = 'aegistrans_session';
const DEVICE_KEY = 'aegistrans_device_id';

// 假 React：useState 可由測試指定初值（slot 0 = session），記錄 setter 呼叫、收集 effect
const fakeReact = `
export function useState(init) {
  const h = globalThis.__hook; const slot = h.slots++;
  const value = slot in h.values ? h.values[slot] : (typeof init === 'function' ? init() : init);
  return [value, (v) => h.sets.push([slot, v])];
}
export function useEffect(fn, deps) { globalThis.__hook.effects.push({ fn, deps }); }
export function useCallback(fn) { return fn; }`;
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^react$|^\.\/(fingerprint|keyEncryption|apiBase)$|services\/(accountWipe|keyEncryption)$/ },
    (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === 'react' ? fakeReact
    : a.path.includes('apiBase') ? 'export const apiBase = () => "https://api.test";'
    : a.path.includes('fingerprint') ? 'export async function computeMachineFingerprint(){ return "fp" }'
    : a.path.includes('accountWipe') ? 'export async function wipeLocalAccountData(){} export async function hasLocalAccountData(){ return "empty" }'
    : `export async function clearEncryptionKey(){} export async function deriveEncryptionKey(){}
       export function setEncryptionKey(){} export async function rekeyProtectedRecords(){}` }));
} };
const build = (entry, out) => require('esbuild').build({ entryPoints: [src(entry)], bundle: true, platform: 'node',
  format: 'esm', outfile: join(dir, out), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
await build('services/auth.ts', 'a.mjs');
await build('hooks/useAuth.ts', 'h.mjs');

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window = { location: { search: '' }, history: { replaceState() {} } };
const auth = await import(pathToFileURL(join(dir, 'a.mjs')));
const { useAuth } = await import(pathToFileURL(join(dir, 'h.mjs')));

const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
};
const res = (status, body) => ({ ok: status >= 200 && status < 300, status,
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });
const ping = async (status, body) => { globalThis.fetch = async () => res(status, body); return auth.pingDevice('dev-1', 'jwt'); };
const settle = () => new Promise((r) => setTimeout(r, 20));

// API 原始碼：_require_user 的 401 與 ping 的 404（用來確認前端清單跟 API 一致，不會各自漂移）
const routes = readFileSync(join(root, 'api/aegistrans_routes.py'), 'utf8');
const requireUser = routes.slice(routes.indexOf('def _require_user('), routes.indexOf('\ndef ', routes.indexOf('def _require_user(') + 1));
const requireUser401 = [...requireUser.matchAll(/HTTPException\(401, "([^"]+)"\)/g)].map((m) => m[1]);
const pingRoute = routes.slice(routes.indexOf('/devices/{device_id}/ping'), routes.indexOf('return {"ok": True, "last_seen_at"'));
const ping404 = [...pingRoute.matchAll(/HTTPException\(404, "([^"]+)"\)/g)].map((m) => m[1]);
const NOT_REVOCATION = ['Missing token', 'Invalid or expired token', 'Invalid token'];   // 缺 header／簽章錯（部署出錯）

await check('the API still raises exactly these revocation answers (aegistrans_routes.py)', async () => {
  assert.deepEqual([...requireUser401].sort(), [...NOT_REVOCATION, 'Account no longer exists', 'Legacy session; please sign in again',
    'Session revoked or expired', 'Device revoked'].sort(), `_require_user 401 details changed: ${requireUser401.join(' | ')}`);
  assert.deepEqual(ping404, ['Device not found'], `ping 404 detail changed: ${ping404.join(' | ')}`);
});

await check('pingDevice: only the API\'s own revocation answers are "revoked"', async () => {
  const revocations = [...requireUser401.filter((d) => !NOT_REVOCATION.includes(d)).map((d) => [401, d]), ...ping404.map((d) => [404, d])];
  assert.equal(revocations.length, 5);
  for (const [status, detail] of revocations) assert.equal(await ping(status, { detail }), 'revoked', `${status} "${detail}"`);
  assert.equal(await ping(200, { ok: true }), 'ok');
});

await check('pingDevice: a bad deploy / proxy / other errors keep the session', async () => {
  const cases = [
    [401, { detail: 'Invalid or expired token' }, 'wrong JWT secret'],
    [401, { detail: 'Missing token' }, 'missing header'],
    [401, { detail: 'Invalid token' }, 'token without sub'],
    [401, '<html>401</html>', 'proxy HTML'],
    [404, { detail: 'Not Found' }, 'aegistrans routes not mounted in the shared AegisTalk process / proxy'],
    [404, '<html>Not Found</html>', 'proxy 404 page'],
    [403, { detail: 'Device revoked' }, '403 is never a revocation'],
    [403, { detail: 'Device not registered or revoked' }, 'MQTT-token wording is not a ping answer'],
    [401, { detail: { error: 'Device revoked' } }, 'non-string detail'],
    [500, { detail: 'Device revoked' }, 'server error'],
    [502, 'Bad gateway', 'gateway'],
  ];
  for (const [status, body, why] of cases) assert.equal(await ping(status, body), 'unreachable', `${status} ${why}`);
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await auth.pingDevice('dev-1', 'jwt'), 'unreachable', 'no network');
});

await check('revocationStreak(2): two consecutive revoked checks sign out; anything else in between resets', async () => {
  assert.equal(typeof auth.revocationStreak, 'function', 'auth.revocationStreak does not exist');
  const streak = auth.revocationStreak(2);
  assert.equal(streak('revoked'), false, 'one revoked check does not sign out');
  assert.equal(streak('unreachable'), false);
  assert.equal(streak('revoked'), false, 'reset by an unreachable check');
  assert.equal(streak('ok'), false);
  assert.equal(streak('revoked'), false);
  assert.equal(streak('revoked'), true, 'second consecutive revoked check signs out');
});

// ── 開著的 App：真的 useAuth「Session 變動後」那段（每 20 秒刷新裝置清單，失敗時 ping 這台）──
const session = { user: { id: 'u1', email: 'a@b.test' }, jwt: 'jwt-1', expiresAt: Math.floor(Date.now() / 1000) + 86_400 };
const REVOKED = [401, { detail: 'Device revoked' }];
/**
 * 已登入、開著的 App 跑幾輪週期刷新。每一輪：'list-ok'＝清單抓成功；'offline'＝清單與 ping 都連不到；
 * 其餘＝清單失敗（503），ping 回 [status, body]。回傳每一輪之後是否已登出。
 */
async function openApp(rounds) {
  store.clear();
  store.set(SESSION_KEY, JSON.stringify(session));
  store.set(DEVICE_KEY, 'dev-1');
  let round = null;
  const pings = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (round === 'offline') throw new TypeError('Failed to fetch');
    if (u.endsWith('/password/status')) return res(200, { has_password: true });
    if (u.endsWith('/auth/devices')) return round === 'list-ok' ? res(200, { devices: [{ id: 'dev-1', pubkey: 'P1' }] }) : res(503, { detail: 'down' });
    if (u.endsWith('/devices/dev-1/ping')) { pings.push(round); return res(round[0], round[1]); }
    throw new Error(`unexpected request ${u}`);
  };
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let tick = null;
  globalThis.setInterval = (fn, ms) => { if (ms === 20_000) { tick = fn; return 1; } return realSetInterval(fn, ms); };
  globalThis.clearInterval = (h) => { if (h !== 1) realClearInterval(h); };
  try {
    globalThis.__hook = { slots: 0, sets: [], effects: [], values: { 0: session } };
    useAuth();
    const effect = globalThis.__hook.effects.find((e) => Array.isArray(e.deps) && e.deps.length === 1 && e.deps[0] === session);
    assert.ok(effect, 'the "session changed" effect (deps [session]) exists');
    const signedOut = [];
    for (let i = 0; i < rounds.length; i++) {
      round = rounds[i];
      if (i === 0) effect.fn(); else { assert.ok(tick, 'the device list refreshes every 20 s'); tick(); }
      await settle();
      signedOut.push(!store.has(SESSION_KEY) && globalThis.__hook.sets.some(([slot, v]) => slot === 0 && v === null));
    }
    return { signedOut, pings };
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
}

await check('open app: a revoked device signs itself out after two consecutive periodic checks (not after one)', async () => {
  const r = await openApp([REVOKED, REVOKED]);
  assert.equal(r.pings.length, 2, `a failed refresh pings this device (pinged ${r.pings.length}×)`);
  assert.deepEqual(r.signedOut, [false, true], `signed out after rounds: [${r.signedOut.join(', ')}]`);
  const r404 = await openApp([[404, { detail: 'Device not found' }], REVOKED]);
  assert.deepEqual(r404.signedOut, [false, true], 'ping 404 "Device not found" counts too');
});

await check('open app: a bad deploy, a proxy or no network never signs out', async () => {
  for (const [why, reply] of [['wrong JWT secret', [401, { detail: 'Invalid or expired token' }]],
    ['routes not mounted', [404, { detail: 'Not Found' }]], ['proxy HTML', [404, '<html>Not Found</html>']],
    ['403', [403, { detail: 'Device revoked' }]], ['5xx', [503, { detail: 'down' }]]]) {
    const r = await openApp([reply, reply, reply]);
    assert.deepEqual(r.signedOut, [false, false, false], `${why}: signed out after rounds [${r.signedOut.join(', ')}]`);
  }
  const offline = await openApp(['offline', 'offline', 'offline']);
  assert.deepEqual(offline.signedOut, [false, false, false], 'offline');
});

await check('open app: a successful list or an unreachable ping in between resets the count', async () => {
  const r = await openApp([REVOKED, 'list-ok', REVOKED, REVOKED]);
  assert.deepEqual(r.signedOut, [false, false, false, true], `list ok in between: [${r.signedOut.join(', ')}]`);
  const r2 = await openApp([REVOKED, [503, { detail: 'down' }], REVOKED, REVOKED]);
  assert.deepEqual(r2.signedOut, [false, false, false, true], `unreachable ping in between: [${r2.signedOut.join(', ')}]`);
});

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall sign-out rule checks passed');
