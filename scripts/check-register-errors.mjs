/**
 * 裝置註冊的錯誤要分清楚（對應 TofuTalk ae21506，審查 LOW）：真的 services/auth.ts registerCurrentDevice
 * （esbuild，stub 掉指紋／金鑰）＋ App.tsx 開機流程的接線。
 *   以前（3a874b3）409/422 以外的錯誤（含 400、401）一律當成「網路錯」→ 開機流程每 5–60 秒重試到天荒地老；
 *   被撤銷的裝置也只是一直重試；請求卡住時開機流程停在這一步、走不到重試。
 *   現在：
 *   - 連不到、逾時（20 秒）、5xx、429 → network（重試）；
 *   - 401：API 自己的撤銷回應（api/aegistrans_routes.py _require_user）→ revoked（登出，跟 session 檢查同一套規則）；
 *     其他 401（例如部署出錯的 JWT secret）當成暫時性 → network（保留登入、稍後重試）；
 *   - 其他 4xx（含不是裝置上限的 409）→ rejected（畫面上顯示錯誤，不重試）；
 *   - 不是 JSON 的錯誤回應（代理／WAF 的錯誤頁、空內容；含 409／422）不是 API 的回答 → network（對應 TofuTalk 2b55267）；
 *   - 404 {"detail":"Not Found"}（共用的 AegisTalk 行程沒掛上 aegistrans 路由）→ network（AegisTrans 審查 M3）。
 *   逾時用 AbortController＋計時器（iOS 15 沒有 AbortSignal.timeout）。
 * Run: node scripts/check-register-errors.mjs
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
const dir = mkdtempSync(join(tmpdir(), 'regerr-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/(fingerprint|keyEncryption|apiBase)$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path.includes('apiBase') ? 'export const apiBase = () => "https://api.test";'
    : a.path.includes('fingerprint') ? 'export async function computeMachineFingerprint(){ return "fp" }'
    : 'export async function clearEncryptionKey(){}' }));
} };
await require('esbuild').build({ entryPoints: [src('services/auth.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'r.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
globalThis.navigator ??= { userAgent: 'node-test' };
const { registerCurrentDevice } = await import(pathToFileURL(join(dir, 'r.mjs')));

const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
};
const answer = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => {
  if (typeof body === 'string') throw new SyntaxError('not json'); return body; } });
const register = async (status, body) => { globalThis.fetch = answer(status, body); return registerCurrentDevice('jwt', 'PK'); };

await check('network errors, 5xx and 429 are retried (reason network)', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal((await registerCurrentDevice('jwt', 'PK')).reason, 'network', 'fetch threw');
  for (const status of [500, 502, 503, 504, 429]) assert.equal((await register(status, { detail: 'x' })).reason, 'network', `HTTP ${status}`);
  assert.equal((await register(502, '<html>bad gateway</html>')).reason, 'network', 'HTML 502');
});

await check('401 with the API\'s own revocation answer → revoked (sign out); any other 401 keeps the session (retry)', async () => {
  for (const detail of ['Device revoked', 'Session revoked or expired', 'Account no longer exists', 'Legacy session; please sign in again']) {
    assert.equal((await register(401, { detail })).reason, 'revoked', `401 "${detail}"`);
  }
  assert.equal((await register(401, { detail: 'Invalid or expired token' })).reason, 'network', 'a bad deploy (wrong JWT secret) is not a revocation');
  assert.equal((await register(401, '<html>401</html>')).reason, 'network', 'a proxy 401 page is not a revocation');
});

await check('other 4xx → rejected with status and message (no retry loop)', async () => {
  for (const [status, body, message] of [[400, { detail: 'Invalid label' }, 'Invalid label'], [403, { detail: 'Forbidden' }, 'Forbidden'],
    [404, { detail: 'Device not registered' }, 'Device not registered'], [409, { detail: 'conflict' }, 'conflict'],
    [413, { detail: 'too large' }, 'too large']]) {
    const r = await register(status, body);
    assert.equal(r.reason, 'rejected', `HTTP ${status} → ${r.reason}`);
    assert.equal(r.status, status);
    assert.ok(String(r.message).includes(message), `message "${r.message}" mentions "${message}"`);
  }
  const limit = await register(409, { detail: { error: 'device_limit_exceeded', tier: 'free', tier_limit: 2, device_count: 2, devices: [] } });
  assert.equal(limit.reason, 'device_limit_exceeded', 'the device-limit gate still works');
  assert.equal((await register(422, { detail: 'cap' })).reason, 'hard_cap', '422 unchanged');
  store.clear();
  const ok = await register(200, { id: 'dev-9', label: 'x', user_agent: null, pubkey: 'PK', first_seen_at: 1, last_seen_at: 1 });
  assert.ok(ok.ok && store.get('aegistrans_device_id') === 'dev-9', 'success still stores the device id');
});

// 對應 TofuTalk 2b55267（審查 LOW-3；AegisTrans 審查 M3）：部署中反向代理／WAF 回的 HTML 404／403 被當成 rejected → 開機流程
// 停住、顯示錯誤，部署完也不會自己好。API（FastAPI）的錯誤一律是 JSON；不是 JSON 的錯誤頁就不是 API 的回答 → 當成暫時性
// （network，退避重試）。
await check('a non-JSON 4xx (proxy / WAF error page, empty body) is retried as network, not shown as rejected', async () => {
  for (const [status, body] of [[403, '<html>Forbidden</html>'], [404, '<html>Not Found</html>'], [400, ''],
    [409, '<html>Conflict</html>'], [413, '<html>too large</html>'], [422, '<html>Unprocessable</html>']]) {
    const r = await register(status, body);
    assert.equal(r.reason, 'network', `HTTP ${status} non-JSON → ${r.reason}`);
  }
  assert.equal((await register(400, { detail: 'Invalid label' })).reason, 'rejected', "the API's own JSON 400 is still rejected");
});

// AegisTrans 審查 M3：aegistrans 路由掛在共用的 AegisTalk API 行程裡；aegistrans_routes.py 匯入失敗就整組不掛，FastAPI 對
// /aegistrans/* 一律回 404 {"detail":"Not Found"}（scripts/check-register-route-missing.py 釘住這個回答；register 自己從不
// 回 404）。這是部署狀態，不是這台裝置的問題 → network（退避重試），重新部署後自己好。
await check('the shared API process without the aegistrans routes (404 {"detail":"Not Found"}) is retried as network', async () => {
  const r = await register(404, { detail: 'Not Found' });
  assert.equal(r.reason, 'network', `bare FastAPI 404 → ${r.reason}`);
});

await check('a hung registration times out as network after 20 s without AbortSignal.timeout (iOS 15); the timer is cleared', async () => {
  const originalTimeout = AbortSignal.timeout;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const armed = []; const cleared = [];
  delete AbortSignal.timeout;              // iOS 15 WebView：沒有這個 API
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms !== 20_000) return realSetTimeout(fn, ms, ...rest);
    const t = { fn, ms }; armed.push(t); return t;
  };
  globalThis.clearTimeout = (t) => { if (armed.includes(t)) cleared.push(t); else realClearTimeout(t); };
  try {
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      if (!init?.signal) return;             // 沒帶 signal → 永遠卡住
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const p = registerCurrentDevice('jwt', 'PK');
    for (let i = 0; i < 5 && armed.length === 0; i++) await new Promise((r) => realSetTimeout(r, 0));
    assert.equal(armed.length, 1, `registerCurrentDevice must arm a 20 s timeout that works without AbortSignal.timeout (armed ${armed.length})`);
    armed[0].fn();
    assert.equal((await p).reason, 'network', 'a hung request is retried like a network error');
    armed.length = 0; cleared.length = 0;
    const ok = await register(200, { id: 'dev-1', label: 'x', user_agent: null, pubkey: 'PK', first_seen_at: 1, last_seen_at: 1 });
    assert.ok(ok.ok, 'registered');
    assert.ok(armed.length === 1 && cleared.length === 1 && cleared[0] === armed[0], 'the timer is cleared once the request finishes');
  } finally {
    AbortSignal.timeout = originalTimeout;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

await check('App.tsx boot: revoked signs out, rejected is shown and not retried, network keeps retrying', async () => {
  const app = readFileSync(src('App.tsx'), 'utf8');
  const start = app.indexOf('// === Lifecycle: 等隨機 identity ready');
  const boot = app.slice(start, app.indexOf('\n  }, [', start));
  const branch = (reason) => {
    const at = boot.indexOf(`regResult.reason === '${reason}'`);
    return at < 0 ? '' : boot.slice(at, boot.indexOf('return;', at) + 7);
  };
  assert.ok(/auth\.signOut\(\)/.test(branch('revoked')), 'revoked → auth.signOut()');
  const rejected = branch('rejected');
  assert.ok(rejected && /setBootError\(/.test(rejected) && !/retryNow/.test(rejected), 'rejected → setBootError, no retry');
  assert.ok(/setBootError\(null\);\s*\/\/ 3\)/.test(boot), 'a successful registration clears the error');
  assert.ok(/\{bootError && /.test(app) && /aegisT\(language, 'app\.registerRejected'\)/.test(app), 'the boot error is rendered (localized)');
  const strings = readFileSync(src('i18n/aegistrans-strings.ts'), 'utf8');
  const line = strings.split('\n').find((l) => l.includes("'app.registerRejected'")) ?? '';
  for (const lang of ["'zh-TW'", "'zh-CN'", 'en:', 'ja:', 'ko:']) assert.ok(line.includes(lang), `app.registerRejected has ${lang}`);
});

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall registration error checks passed');
