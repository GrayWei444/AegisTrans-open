/**
 * 換 token 時好好斷線，等 DISCONNECT 的那段時間不能丟訊息，等不到也要真的關掉（對應 TofuTalk bcb9671，審查 LOW-2；40f2232）：
 *   真的 mqtt.ts（connect／_renewToken／_endGracefully），mqtt.js 換成一個照 5.x 行為寫的假 client：
 *   - client 自己掛一個 'close' listener（mqtt.js 在 close 時停 keepalive）；
 *   - end(false) 要等送出中的 QoS 1 完成才送 DISCONNECT；end() 進行中再呼叫 end() 只回 callback（不會強制關）。
 *   以前 _endGracefully 先 removeAllListeners()：
 *   1. 等待中 broker 送來的 QoS 1 訊息 mqtt.js 照樣回 PUBACK，但沒有 'message' listener → 訊息就這樣不見了；
 *   2. 連 mqtt.js 自己的 'close' 處理也拔掉，2 秒等不到就放著不管 → 舊連線的 socket 與 keepalive 一直留著。
 * Run: node scripts/check-mqtt-graceful-swap.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'aegistrans-swap-'));
const fakeMqtt = `
import { EventEmitter } from 'node:events';
export default { connect() {
  const c = new EventEmitter();
  c.id = globalThis.__clients.length + 1; c.connected = false; c.disconnected = false; c.disconnecting = false;
  c.keepalive = 'running';
  c.on('close', () => { c.connected = false; c.keepalive = 'stopped'; });   // mqtt.js 自己的 close 處理（停 keepalive）
  c.stream = { destroyed: false, destroy() { if (this.destroyed) return; this.destroyed = true; setTimeout(() => c.emit('close'), 0); } };
  c.subscribe = () => {}; c.unsubscribe = () => {};
  c.publish = (t, p, o, cb) => { if (typeof cb === 'function') cb(); };
  c.end = (force, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    const done = () => { if (typeof cb === 'function') cb(); };
    if (c.disconnecting) { done(); return c; }                // mqtt.js 5：end() 進行中再呼叫只回 callback
    c.disconnecting = true;
    c.endedWith = force ? 'force' : 'graceful:' + opts?.reasonCode;
    if (force) { c.keepalive = 'stopped'; c.stream.destroy(); setTimeout(done, 0); return c; }
    if (globalThis.__holdEnd === Infinity) return c;          // 還在等送出中的 QoS 1 的 PUBACK：DISCONNECT 送不出去
    setTimeout(() => { c.keepalive = 'stopped'; c.stream.destroy(); done(); }, globalThis.__holdEnd ?? 0);
    return c;
  };
  globalThis.__clients.push(c);
  setTimeout(() => { if (!c.disconnecting) { c.connected = true; c.emit('connect'); } }, 20);
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
const { mqttService: svc, MessageType } = await import(pathToFileURL(join(dir, 'm.mjs')));

const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = 'A'.repeat(43) + '=';
const PEER = 'B'.repeat(43) + '=';
const inbox = `mist/acct/u1/user/${ME.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}/inbox`;
const inboundFrom = (from, n) => Buffer.from(JSON.stringify({ type: MessageType.ENCRYPTED_MESSAGE, from, payload: `m${n}`, timestamp: Date.now() }));

svc._fetchMqttToken = async () => 'TOKEN';
svc._mqttTokenExpiresAt = Date.now() + 3600_000;
await svc.connect(ME, false, 'u1');
const received = [];
svc.onMessage(MessageType.ENCRYPTED_MESSAGE, (m) => received.push(m.payload));

await check('QoS 1 messages that arrive while the old connection is still disconnecting reach the handlers', async () => {
  globalThis.__holdEnd = 150;
  const old = svc.client;
  const renewal = svc._renewToken();
  await sleep(20);
  assert.equal(old.endedWith, 'graceful:0', 'the renewal sends DISCONNECT (reason 0)');
  old.emit('message', inbox, inboundFrom(PEER, 1));          // broker 在 DISCONNECT 完成前送來（mqtt.js 已回 PUBACK）
  await renewal;
  assert.deepEqual(received, ['m1'], `delivered during the swap: [${received.join(', ')}]`);
  assert.notEqual(svc.client, old, 'swapped to a new client');
  await sleep(40);
  assert.equal(svc.getState(), 'connected');
  old.emit('close');                                          // 舊 client 晚到的事件不影響新的連線狀態
  old.emit('error', new Error('late'));
  assert.equal(svc.getState(), 'connected', 'late events from the old client do not touch the state');
});

await check('a DISCONNECT that never completes: after 2 s the old socket is closed and its keepalive stops', async () => {
  globalThis.__holdEnd = Infinity;
  const old = svc.client;
  const started = Date.now();
  await svc._renewToken();
  const waited = Date.now() - started;
  assert.ok(waited >= 1900 && waited < 3000, `waited ${waited} ms for the DISCONNECT`);
  await sleep(20);
  assert.equal(old.stream.destroyed, true, 'the old socket is closed after the wait');
  assert.equal(old.keepalive, 'stopped', "the old client's keepalive stops (mqtt.js's own close handling still attached)");
  assert.notEqual(svc.client, old);
});

svc._teardown();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall graceful swap checks passed');
process.exit(0);
