/**
 * 換 token 的換連線跟 health monitor 的 forceReconnect 撞在一起（AegisTrans 審查 B；對應 TofuTalk cc9290c；40f2232＋health monitor）：
 *   真的 mqtt.ts（connect／_renewToken／_endGracefully／_teardown／forceReconnect），mqtt.js 換成假的（連上要 200 ms）。
 *   以前 _endGracefully 先把 this.client 設成 null、最多等 2 秒；這段時間 health monitor 看到「沒連線」→ forceReconnect
 *   開第二條；_renewToken 接著 _teardown() 拆掉第二條、再開第三條 → 第二條的 connect promise 永遠不 settle，
 *   health monitor 卡在 reconnecting，之後再也不重連。
 *   現在：整個換連線算一次進行中的 connect（拔掉舊 client 之前就佔著 connectingPromise）；換連線中 forceReconnect 等它
 *   完成、不另開；connect() 等完 token 再看一次有沒有別的連線已經開始；被拆掉的 connect 一定 reject（不會永遠等）。
 * Run: node scripts/check-mqtt-renewal-race.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'aegistrans-renewrace-'));
const fakeMqtt = `
import { EventEmitter } from 'node:events';
export default { connect() {
  const c = new EventEmitter(); c.id = globalThis.__clients.length + 1; c.connected = false; c.disconnected = false;
  c.subscribe = () => {}; c.unsubscribe = () => {}; c.publish = (t, p, o, cb) => { (globalThis.__pubs ??= []).push(t); if (typeof cb === 'function') cb(); };
  c.stream = { destroy() {} };
  c.end = (force, o, cb) => { if (typeof o === 'function') { cb = o; } c.ended = force ? 'force' : 'graceful'; c.connected = false;
    c.disconnected = true; setTimeout(() => { if (typeof cb === 'function') cb(); }, 50); return c; };
  globalThis.__clients.push(c);
  setTimeout(() => { if (!c.ended) { c.connected = true; c.emit('connect'); } }, globalThis.__connectMs ?? 200);
  return c;
} };`;
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^mqtt$|utils\/devLog$|utils\/diagLog$|\.\/deviceId$|\.\/apiBase$|\.\/database$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', resolveDir: root, contents:
    a.path === 'mqtt' ? fakeMqtt
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('deviceId') ? 'export const getDeviceIdSync=()=>"0b6f4c1e8a2d4c3b";'
    : a.path.includes('apiBase') ? 'export function apiBase(){ return "https://api.invalid" }'
    : 'export async function getSetting(){ return null }' }));
} };
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/mqtt.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub] });
globalThis.__clients = [];
const store = { mist_pin_hash: 'h', aegistrans_device_id: 'dev-1' };
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem(k, v) { store[k] = v; }, removeItem(k) { delete store[k]; } };
globalThis.WebSocket = { OPEN: 1 };
console.warn = () => {}; console.error = () => {};
const { mqttService: svc } = await import(pathToFileURL(join(dir, 'm.mjs')));

const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** promise 在 ms 內有沒有 settle */
const settles = (p, ms) => Promise.race([p.then(() => 'resolved', () => 'rejected'), sleep(ms).then(() => 'pending')]);
const ME = 'A'.repeat(43) + '=';
let tokenDelay = 0;
svc._fetchMqttToken = async () => { if (tokenDelay) await sleep(tokenDelay); return 'TOKEN'; };
svc._mqttTokenExpiresAt = Date.now() + 3600_000;

await svc.connect(ME, false, 'u1');

await check('a health-monitor forceReconnect during the renewal swap joins it: one new client, every promise settles', async () => {
  const before = globalThis.__clients.length;
  const renewal = svc._renewToken();
  await sleep(5);
  assert.equal(svc.client, null, 'inside the swap window (old client detached, new one not created yet)');
  const forced = svc.forceReconnect();                      // health monitor：「沒連線」
  assert.equal(await settles(forced, 3000), 'resolved', 'forceReconnect settles (the monitor does not stay "reconnecting")');
  assert.notEqual(await settles(renewal, 3000), 'pending', 'the renewal settles');
  assert.equal(globalThis.__clients.length - before, 1, `clients created during the swap: ${globalThis.__clients.length - before}`);
  assert.equal(svc.getState(), 'connected');
  assert.equal(svc.client?.connected, true);
  assert.equal(svc.connectingPromise, null, 'nothing left in progress');
});

await check('connect() during the swap waits for it instead of opening another connection', async () => {
  const before = globalThis.__clients.length;
  const renewal = svc._renewToken();
  await sleep(5);
  const joined = svc.connect(ME, false, 'u1');
  assert.equal(await settles(joined, 3000), 'resolved');
  await renewal;
  assert.equal(globalThis.__clients.length - before, 1);
  assert.equal(svc.client?.connected, true);
});

await check('two connects racing while the token is fetched open a single connection', async () => {
  svc._teardown();
  const before = globalThis.__clients.length;
  tokenDelay = 50;
  const first = svc.connect(ME, false, 'u1');
  await sleep(10);
  const forced = svc.forceReconnect();                       // health monitor 在等 token 的時候進來
  assert.equal(await settles(Promise.all([first, forced]), 3000), 'resolved');
  tokenDelay = 0;
  assert.equal(globalThis.__clients.length - before, 1, `clients created: ${globalThis.__clients.length - before}`);
  assert.equal(svc.client?.connected, true);
  const extra = globalThis.__clients.slice(before).filter((c) => c !== svc.client && !c.ended);
  assert.deepEqual(extra.map((c) => c.id), [], 'no orphaned live client');
});

await check('a connect torn down before it connects rejects (nobody waits forever on it)', async () => {
  svc._teardown();
  globalThis.__connectMs = 500;
  const pending = svc.connect(ME, false, 'u1');
  await sleep(20);
  svc._teardown();                                           // 例如登出、或重連把它拆掉
  assert.equal(await settles(pending, 2000), 'rejected');
  globalThis.__connectMs = 200;
});

// AegisTrans 審查 C（對應 TofuTalk afc85e8）：每次連上都發 roster ping → 其他裝置全部 invalidate、重抓清單。換 token 的重連
// 每小時一次、裝置沒變，不發。
await check('a token-renewal reconnect does not publish a roster ping; a regular connect still does', async () => {
  svc._teardown();
  globalThis.__pubs = [];
  await svc.connect(ME, false, 'u1');
  assert.ok(globalThis.__pubs.includes('mist/acct/u1/devices'), 'a regular connect announces the device');
  globalThis.__pubs = [];
  await svc._renewToken();
  assert.equal(svc.client?.connected, true);
  assert.ok(!globalThis.__pubs.includes('mist/acct/u1/devices'), `published after the renewal: [${globalThis.__pubs.join(', ')}]`);
});

svc._teardown();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall renewal race checks passed');
process.exit(0);
