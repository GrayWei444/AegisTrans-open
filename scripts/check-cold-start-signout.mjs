/**
 * 沒網路或伺服器暫時出錯時開 App 不能把使用者登出（對應 TofuTalk 4518958 + 7c7251e）：
 *   真的 hooks/useAuth.ts 開機那段 + 真的 services/auth.ts pingDevice（esbuild；React、指紋、金鑰、本機資料清除都 stub 掉）。
 *   以前冷啟動 pingDevice 任何失敗都回 false，useAuth 收到 false 就登出 → 離線開 App、伺服器 5xx 或請求卡住時都被登出。
 *   pingDevice 三態：'ok'／'revoked'／'unreachable'（沒網路、逾時、5xx、其他 4xx），只有 'revoked' 才登出。
 *   'revoked' 只認 API 自己的撤銷回應（api/aegistrans_routes.py：401 "Device revoked"／"Session revoked or expired"／
 *   "Account no longer exists"／"Legacy session; please sign in again"、ping 的 404 "Device not found"）——
 *   不再是任何 401／403／404：JWT secret 設錯（401 "Invalid or expired token"）、共用 AegisTalk 行程沒掛上 aegistrans
 *   路由（404 "Not Found"）、反向代理的錯誤頁都保留登入。冷啟動檢查一次即可（開著的 App 見 check-auth-revocation）。
 * Run: node scripts/check-cold-start-signout.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => join(root, 'packages/pwa/src', p);
const require = createRequire(join(root, 'packages/pwa/package.json'));
const dir = mkdtempSync(join(tmpdir(), 'coldstart-'));
const SESSION_KEY = 'aegistrans_session';
const DEVICE_KEY = 'aegistrans_device_id';

// 假 React：記錄每個 useState 的 setter 呼叫、收集 effect（開機那段是唯一 deps 為 [] 的 effect）
const fakeReact = `
export function useState(init) {
  const h = globalThis.__hook; const slot = h.slots++;
  const value = typeof init === 'function' ? init() : init;
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
await build('hooks/useAuth.ts', 'h.mjs');
await build('services/auth.ts', 'a.mjs');

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window = { location: { search: '' }, history: { replaceState() {} } };
const session = { user: { id: 'u1', email: 'a@b.test' }, jwt: 'jwt-1', expiresAt: Math.floor(Date.now() / 1000) + 86_400 };
const settle = () => new Promise((r) => setTimeout(r, 20));
const { useAuth } = await import(pathToFileURL(join(dir, 'h.mjs')));

/** 已登入的裝置冷啟動一次；fetch 由 respond 決定。回傳本機 session 是否還在、畫面最後的 session 值、ping 請求 */
async function coldStart(respond) {
  store.clear();
  store.set(SESSION_KEY, JSON.stringify(session));
  store.set(DEVICE_KEY, 'dev-1');
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return respond(); };
  globalThis.__hook = { slots: 0, sets: [], effects: [] };
  useAuth();
  const mount = globalThis.__hook.effects.filter((e) => Array.isArray(e.deps) && e.deps.length === 0);
  assert.equal(mount.length, 1, 'exactly one mount effect');
  mount[0].fn();
  await settle();
  const sets = globalThis.__hook.sets;
  const slot = sets.find(([, v]) => v && typeof v === 'object' && v.jwt)?.[0];
  assert.notEqual(slot, undefined, 'the stored session is restored into state');
  const shown = sets.filter(([s]) => s === slot).map(([, v]) => v).at(-1);
  return { stored: store.has(SESSION_KEY) && store.has(DEVICE_KEY), shown, calls };
}
const res = (status, body = {}) => ({ ok: status >= 200 && status < 300, status,
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });
const REVOCATIONS = [[401, 'Device revoked'], [401, 'Session revoked or expired'], [401, 'Account no longer exists'],
  [401, 'Legacy session; please sign in again'], [404, 'Device not found']];
const NOT_REVOCATIONS = [[401, { detail: 'Invalid or expired token' }], [401, { detail: 'Missing token' }], [401, {}],
  [403, { detail: 'Device revoked' }], [403, {}], [404, { detail: 'Not Found' }], [404, '<html>Not Found</html>'], [404, {}]];

// ── 1. 冷啟動：只有伺服器明確說失效才登出 ──
let r = await coldStart(() => { throw new TypeError('Failed to fetch'); });
assert.ok(r.calls.length === 1 && r.calls[0].url === 'https://api.test/aegistrans/auth/devices/dev-1/ping'
  && r.calls[0].init.method === 'POST' && r.calls[0].init.headers.Authorization === 'Bearer jwt-1', 'cold start pings this device');
assert.ok(r.stored && r.shown?.jwt === 'jwt-1', 'opening the app offline keeps the user signed in');
for (const status of [500, 502, 503, 504]) {
  r = await coldStart(() => res(status));
  assert.ok(r.stored && r.shown?.jwt === 'jwt-1', `a server error (${status}) keeps the user signed in`);
}
r = await coldStart(() => res(200));
assert.ok(r.stored && r.shown?.jwt === 'jwt-1', 'a successful ping keeps the session');
for (const [status, body] of NOT_REVOCATIONS) {
  r = await coldStart(() => res(status, body));
  assert.ok(r.stored && r.shown?.jwt === 'jwt-1', `${status} ${JSON.stringify(body)} is not the API's revocation answer → keeps the session`);
}
for (const [status, detail] of REVOCATIONS) {
  r = await coldStart(() => res(status, { detail }));
  assert.ok(!r.stored && r.shown === null, `the API saying the session/device is gone (${status} "${detail}") still signs out`);
}
console.log('PASS cold start signs out only on the API\'s own revocation answers; offline, 5xx, bad deploys and proxies keep the session');

// ── 2. pingDevice 三態（含請求卡住逾時）──
const { pingDevice } = await import(pathToFileURL(join(dir, 'a.mjs')));
globalThis.fetch = async () => res(204);
assert.equal(await pingDevice('dev-1', 'jwt-1'), 'ok');
for (const [status, detail] of REVOCATIONS) {
  globalThis.fetch = async () => res(status, { detail });
  assert.equal(await pingDevice('dev-1', 'jwt-1'), 'revoked', `${status} "${detail}" → revoked`);
}
for (const [status, body] of [...NOT_REVOCATIONS, [400, {}], [429, {}], [500, {}], [503, {}]]) {
  globalThis.fetch = async () => res(status, body);
  assert.equal(await pingDevice('dev-1', 'jwt-1'), 'unreachable', `${status} ${JSON.stringify(body)} → unreachable (not proof the session is gone)`);
}
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
assert.equal(await pingDevice('dev-1', 'jwt-1'), 'unreachable', 'network error → unreachable');

// 請求卡住：計時器到了要中止請求、回 unreachable，請求結束後計時器要清掉
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const timers = [];
const cleared = [];
globalThis.setTimeout = (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; };
globalThis.clearTimeout = (t) => { cleared.push(t); };
try {
  globalThis.fetch = (_url, init) => new Promise((_ok, fail) => {
    init?.signal?.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError')));
  });
  const pending = pingDevice('dev-1', 'jwt-1');
  assert.equal(timers.length, 1, 'the ping arms a timeout');
  assert.ok(timers[0].ms > 0 && timers[0].ms <= 30_000, `timeout is bounded (${timers[0].ms} ms)`);
  timers[0].fn();
  assert.equal(await pending, 'unreachable', 'a hung request times out as unreachable');
  globalThis.fetch = async () => res(200);
  timers.length = 0; cleared.length = 0;
  assert.equal(await pingDevice('dev-1', 'jwt-1'), 'ok');
  assert.deepEqual(cleared, timers, 'the timeout is cleared once the request finishes');
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}
console.log('PASS pingDevice: ok / revoked (API revocation answers) / unreachable (network, other 4xx, 5xx, timeout)');
