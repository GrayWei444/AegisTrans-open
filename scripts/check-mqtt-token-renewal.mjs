/**
 * MQTT 通行證（JWT）到期前主動換新（稽核 B21，對應 TofuTalk 8fdad37）：真的 mqtt.ts（stub 掉 mqtt.js 與網路）。
 *   token 1 小時有效；以前只在 connect() 時換 token，連線中從不換。broker 若在到期時斷線（EMQX 設定不在 repo，
 *   AegisTrans 的 broker 行為未知）就是每小時整點被踢、等健康檢查（前景 10s、背景 30s）才重連、presence 重訂。
 *   現在：連上後排定「到期前 2 分鐘」先拿新 token，拿到才換連線；拿不到就保留現有連線，30 秒後再試。
 *   不延長 token 效期（被撤銷的裝置在效期內還能連）。
 *   換連線時好好斷線（MQTT DISCONNECT，broker 不發 last will）、效期用 JWT 的 exp − iat 算（不受本機時鐘影響）、
 *   只在已連上且沒有 connect 進行中時換（對應 TofuTalk fc6910d）。
 * Run: node scripts/check-mqtt-token-renewal.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/pwa/package.json'));
const dir = mkdtempSync(join(tmpdir(), 'aegistrans-renew-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^mqtt$|utils\/devLog$|utils\/diagLog$|\.\/deviceId$|\.\/apiBase$|\.\/database$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === 'mqtt' ? 'export default { connect(){ throw new Error("no network in tests") } };'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('deviceId') ? 'export const getDeviceIdSync=()=>"0b6f4c1e8a2d4c3b";'
    : a.path.includes('apiBase') ? 'export function apiBase(){ return "https://api.invalid" }'
    : 'export async function getSetting(){ return null }' }));
} };
await require('esbuild').build({ entryPoints: [join(root, 'packages/pwa/src/services/mqtt.ts')], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub] });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
console.warn = () => {}; console.error = () => {};
const timers = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => { if (ms >= 30_000) { timers.push({ fn, ms }); return timers.length; } return realSetTimeout(fn, ms); };
const { mqttService: svc } = await import(pathToFileURL(join(dir, 'm.mjs')));

assert.equal(typeof svc._scheduleTokenRenewal, 'function', 'mqttService schedules a token renewal on connect');
svc.publicKeyBase64 = 'A'.repeat(43) + '=';
const log = [];
// 連線中的 client（換新只在連線中做）；end() 記下是否送 DISCONNECT
const fakeClient = () => ({ connected: true, disconnecting: false, removeAllListeners() {}, on() {},
  end(force, opts, cb) { log.push(force ? 'end:force' : `end:graceful:${opts?.reasonCode}`); if (typeof cb === 'function') cb(); } });
svc.client = fakeClient();
svc._teardown = () => log.push('teardown');
svc.connect = async () => { log.push('connect'); };
svc._open = async () => { log.push('connect'); };   // 換連線用 _open 連（整段算一次進行中的 connect，見 check-mqtt-renewal-race.mjs）
let tokenOk = true;
svc._fetchMqttToken = async () => { log.push('fetch'); return tokenOk ? 'NEW' : null; };

svc._mqttTokenExpiresAt = Date.now() + 60 * 60_000;
svc._scheduleTokenRenewal();
assert.equal(timers.length, 1, 'a renewal is scheduled when connected');
assert.ok(Math.abs(timers[0].ms - 58 * 60_000) < 2_000, `renews about 2 minutes before expiry (got ${Math.round(timers[0].ms / 60_000)} min)`);

await timers[0].fn();
assert.deepEqual(log.filter((x) => x !== 'end:graceful:0'), ['fetch', 'teardown', 'connect'], 'fetches the new token first, then swaps the connection');
svc.client = fakeClient();
console.log('PASS token renewed ~2 min before expiry: fetch first, then reconnect');

log.length = 0; timers.length = 0; tokenOk = false;
svc._mqttTokenExpiresAt = Date.now() + 60_000;
svc._scheduleTokenRenewal();
await timers[0].fn();
assert.deepEqual(log, ['fetch'], 'if the new token cannot be fetched the current connection is kept');
assert.equal(timers.length, 2, 'and another attempt is scheduled');
assert.equal(timers[1].ms, 30_000);
console.log('PASS a failed renewal keeps the connection and retries in 30 s');

// 連上時真的會排定（connect 的 'connect' handler 呼叫 _scheduleTokenRenewal），_teardown 會取消
const mqttSrc = (await import('node:fs')).readFileSync(join(root, 'packages/pwa/src/services/mqtt.ts'), 'utf8');
const onConnect = mqttSrc.slice(mqttSrc.indexOf("this._listen(client, 'connect'"), mqttSrc.indexOf("this._listen(client, 'reconnect'"));
assert.ok(/this\._scheduleTokenRenewal\(\)/.test(onConnect), 'the connect handler schedules the renewal');
const teardown = mqttSrc.slice(mqttSrc.indexOf('private _teardown(): void {'), mqttSrc.indexOf('async forceReconnect()'));
assert.ok(/clearTimeout\(this\._tokenRenewTimer\)/.test(teardown), 'teardown cancels a pending renewal');
console.log('PASS renewal is scheduled on connect and cancelled on teardown');

// ── 對應 TofuTalk fc6910d（審查 LOW）──
//   1. 換連線用 end(true)：不送 DISCONNECT → broker 發 last will（presence 離線，retained）→ 其他裝置每小時看到這台離線一次。
//   2. 用本機時鐘比 exp：時鐘快 ≥ 57.5 分鐘的裝置每 30 秒換一次連線、快取也每次重抓。
//   3. _renewToken 會把正在進行的 connect 拆掉、斷線時也照樣拆。
const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
};
delete svc._teardown;   // 用真的 _teardown（會 end 掉 client）
tokenOk = true;

await check('renewal disconnects gracefully (MQTT DISCONNECT, no last will → peers never see the device go offline)', async () => {
  log.length = 0; timers.length = 0;
  svc.client = fakeClient();
  svc._mqttTokenExpiresAt = Date.now() + 60 * 60_000;
  svc._scheduleTokenRenewal();
  await timers[0].fn();
  assert.deepEqual(log, ['fetch', 'end:graceful:0', 'connect'], `got [${log.join(', ')}]`);
});

await check('renewal is skipped (and rescheduled) unless the client is connected and no connect is in progress', async () => {
  for (const [what, setup] of [['disconnected', () => { svc.client = { ...fakeClient(), connected: false }; }],
    ['connect in progress', () => { svc.client = fakeClient(); svc.connectingPromise = new Promise(() => {}); }]]) {
    log.length = 0; timers.length = 0;
    setup();
    svc._mqttTokenExpiresAt = Date.now() + 60_000;
    svc._scheduleTokenRenewal();
    await timers[0].fn();
    assert.deepEqual(log, [], `${what}: nothing fetched or torn down (got [${log.join(', ')}])`);
    assert.equal(timers.at(-1)?.ms, 30_000, `${what}: rescheduled in 30 s`);
    svc.connectingPromise = null;
  }
});

const realNow = Date.now;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const serverNow = 1_800_000_000;   // 秒
const tokenResponse = (body) => { let fetches = 0;
  globalThis.fetch = async () => { fetches++; return { ok: true, status: 200, json: async () => body }; };
  return () => fetches; };
const realFetchToken = Object.getPrototypeOf(svc)._fetchMqttToken;
const useRealFetchToken = () => {
  svc._fetchMqttToken = realFetchToken;   // 真的 _fetchMqttToken，stub 掉網路（AegisTrans 的 session／device key）
  const store = { mist_pin_hash: 'h', aegistrans_session: JSON.stringify({ jwt: 'user-jwt' }), aegistrans_device_id: 'dev-1' };
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem() {}, removeItem() {} };
  svc._mqttToken = null; svc._mqttTokenExpiresAt = 0; svc._tokenFetchFailedAt = 0;
};

await check('a device whose clock runs ~58 min fast renews ~58 min after receiving the token (lifetime = exp − iat), not every 30 s', async () => {
  useRealFetchToken();
  // aegistrans_routes.py sign_mqtt_jwt：payload 有 iat 與 exp（1 小時），回應是 { token, expiresAt }
  const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'x', exp: serverNow + 3600, iat: serverNow, iss: 'aegisrd' })}.sig`;
  const fetches = tokenResponse({ token, expiresAt: serverNow + 3600 });
  Date.now = () => serverNow * 1000 + 58 * 60_000;
  try {
    assert.equal(await svc._fetchMqttToken(svc.publicKeyBase64), token);
    assert.equal(await svc._fetchMqttToken(svc.publicKeyBase64), token);
    assert.equal(fetches(), 1, `a fresh token is reused from the cache (fetched ${fetches()} times)`);
    timers.length = 0;
    svc.client = fakeClient();
    svc._scheduleTokenRenewal();
    const minutes = timers[0].ms / 60_000;
    assert.ok(Math.abs(minutes - 58) < 1, `renewal scheduled in ${minutes.toFixed(1)} min (want ~58)`);
  } finally { Date.now = realNow; }
});

await check('no iat in the token (not a JWT / older API): expiresAt − receive time, at least 10 min', async () => {
  useRealFetchToken();
  const fetches = tokenResponse({ token: 'opaque-token', expiresAt: serverNow + 3600 });
  Date.now = () => serverNow * 1000 + 58 * 60_000;   // 時鐘快 58 分鐘：expiresAt 只剩 2 分鐘 → 至少當成 10 分鐘
  try {
    assert.equal(await svc._fetchMqttToken(svc.publicKeyBase64), 'opaque-token');
    assert.equal(await svc._fetchMqttToken(svc.publicKeyBase64), 'opaque-token');
    assert.equal(fetches(), 1, `cached (fetched ${fetches()} times)`);
    timers.length = 0;
    svc._scheduleTokenRenewal();
    const minutes = timers[0].ms / 60_000;
    assert.ok(Math.abs(minutes - 8) < 0.5, `renewal scheduled in ${minutes.toFixed(1)} min (want ~8 = 10 − 2)`);
  } finally { Date.now = realNow; }
});

svc._teardown();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
