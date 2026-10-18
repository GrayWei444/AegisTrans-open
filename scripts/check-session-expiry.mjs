/**
 * 30 天 session 自然到期，開著的 App 要登出（對應 TofuTalk 749e349，審查 HIGH-1；28debab／bc41408）：真的 auth.ts（esbuild，stub 掉指紋／金鑰）
 * ＋ useAuth／App.tsx 的接線（需要瀏覽器與 React 才跑得動，看原始碼）。
 *   JWT 的 exp 就是伺服器 session 的到期時間（aegistrans_routes.py 簽 exp＝now＋SESSION_TTL_SECONDS），verify_jwt 在查 session
 *   之前就擋掉 → GET /devices、ping、register 一律回 401 "Invalid or expired token"（scripts/check-session-expiry.py 釘住這個回應）。
 *   那不是撤銷回應 → 週期檢查當成「連不到」、開機註冊無限重試、/mqtt/token 401 → broker 一小時內斷線、health monitor 停掉，
 *   使用者卡在一個什麼都連不上、也不會登出的 App。
 *   現在：本機看 session 自己的效期（session.expiresAt 或 JWT 的 exp）已過 → 當成到期，走一般登出；
 *   同樣的 401 但本機效期還沒到（部署出錯的 JWT secret）→ 照舊不登出。
 * Run: node scripts/check-session-expiry.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname;
const src = root + 'packages/pwa/src/';
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'sessexp-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/(fingerprint|keyEncryption|apiBase)$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path.includes('apiBase') ? 'export const apiBase = () => "https://api.test";'
    : a.path.includes('fingerprint') ? 'export async function computeMachineFingerprint(){ return "fp" }'
    : 'export function clearEncryptionKey(){ return Promise.resolve(); }' }));
} };
await require('esbuild').build({ stdin: { contents: "export * from './services/auth.ts';", resolveDir: src, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'a.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
const auth = await import(pathToFileURL(join(dir, 'a.mjs')));

const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
};

const DAY = 86_400;
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** 跟 aegistrans_routes.py 一樣的 JWT 形狀：exp＝iat＋30 天（簽章內容不重要，App 不驗） */
const jwtWith = (iat, exp) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'u1', sid: 's1', iat, exp })}.c2ln`;
const nowSec = () => Math.floor(Date.now() / 1000);
/** 伺服器在 session 到期後對每個端點的回答（scripts/check-session-expiry.py） */
const expiredAnswer = async () => ({ ok: false, status: 401, headers: { get: () => 'application/json' },
  json: async () => ({ detail: 'Invalid or expired token' }) });

await check('isSessionExpired: at or past the session expiry (session.expiresAt or the JWT exp) → expired; before → not', async () => {
  assert.equal(typeof auth.isSessionExpired, 'function', 'auth.isSessionExpired does not exist');
  const t = nowSec();
  const live = jwtWith(t - 29 * DAY, t + DAY);
  const dead = jwtWith(t - 30 * DAY - 60, t - 60);
  assert.equal(auth.isSessionExpired({ jwt: live, expiresAt: t + DAY }), false, 'a day left');
  assert.equal(auth.isSessionExpired({ jwt: dead, expiresAt: t - 60 }), true, 'a minute past');
  assert.equal(auth.isSessionExpired({ jwt: jwtWith(t - 30 * DAY, t), expiresAt: t }), true, 'exactly at expiry');
  assert.equal(auth.isSessionExpired({ jwt: dead, expiresAt: t + DAY }), true, 'the JWT exp alone has passed');
  assert.equal(auth.isSessionExpired({ jwt: 'not-a-jwt', expiresAt: t - 1 }), true, 'session.expiresAt alone has passed');
  assert.equal(auth.isSessionExpired({ jwt: 'not-a-jwt', expiresAt: t + DAY }), false, 'unparseable JWT, session still valid');
  assert.equal(auth.isSessionExpired({ jwt: live, expiresAt: t + DAY }, (t + 2 * DAY) * 1000), true, 'explicit clock');
});

await check('register: 401 "Invalid or expired token" with the session past its expiry → expired (sign out, no retry loop)', async () => {
  const t = nowSec();
  globalThis.fetch = expiredAnswer;
  const r = await auth.registerCurrentDevice(jwtWith(t - 30 * DAY - 60, t - 60), 'PK');
  assert.equal(r.reason, 'expired', `register classified the expired session as ${r.reason}`);
});

await check('register: the same 401 with a session that is still valid locally → network (wrong JWT secret deploy, keep session)', async () => {
  const t = nowSec();
  globalThis.fetch = expiredAnswer;
  assert.equal((await auth.registerCurrentDevice(jwtWith(t - DAY, t + 29 * DAY), 'PK')).reason, 'network');
});

await check('register: unreachable / 5xx with the session past its expiry → expired (the JWT can never be accepted again)', async () => {
  const dead = jwtWith(nowSec() - 30 * DAY - 60, nowSec() - 60);
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal((await auth.registerCurrentDevice(dead, 'PK')).reason, 'expired', 'no network');
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ detail: 'x' }) });
  assert.equal((await auth.registerCurrentDevice(dead, 'PK')).reason, 'expired', '503');
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ detail: 'Device revoked' }) });
  assert.equal((await auth.registerCurrentDevice(dead, 'PK')).reason, 'revoked', 'an explicit revocation stays a revocation');
});

await check('useAuth: a failed periodic check signs out at once when the session itself has expired, before the revocation ping', async () => {
  const useAuth = readFileSync(src + 'hooks/useAuth.ts', 'utf8');
  const start = useAuth.indexOf('const fetchDevices = () =>');
  const periodic = useAuth.slice(start, useAuth.indexOf('fetchDevices();', start));
  const failed = periodic.slice(periodic.indexOf('.catch('));
  assert.ok(/isSessionExpired\(session\)/.test(failed), 'the catch path checks isSessionExpired(session)');
  assert.ok(failed.indexOf('isSessionExpired(session)') < failed.indexOf('pingDevice('), 'expiry is checked before the revocation ping');
  const expiredBranch = failed.slice(failed.indexOf('isSessionExpired(session)'), failed.indexOf('pingDevice('));
  assert.ok(/signOutService\(\)/.test(expiredBranch) && /setSession\(null\)/.test(expiredBranch) && /return;/.test(expiredBranch),
    'expired → the normal sign-out (service + React state), no ping');
  assert.ok(/if \(cancelled \|\| !revoked\(result\)\) return;/.test(failed), 'a still-valid session keeps the two-strike revocation rule');
});

await check('App.tsx boot: an expired session signs out instead of retrying', async () => {
  const app = readFileSync(src + 'App.tsx', 'utf8');
  const start = app.indexOf('// === Lifecycle: 等隨機 identity ready');
  const boot = app.slice(start, app.indexOf('\n  }, [', start));
  const at = boot.indexOf("regResult.reason === 'expired'");
  assert.ok(at >= 0, "App.tsx boot has no 'expired' branch");
  const branch = boot.slice(at, boot.indexOf('return;', at) + 7);
  assert.ok(/auth\.signOut\(\)/.test(branch) && !/retryNow/.test(branch), 'expired → auth.signOut(), no retry');
  assert.ok(at < boot.indexOf('setTimeout(retryNow'), 'checked before the network retry');
});

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall session expiry checks passed');
