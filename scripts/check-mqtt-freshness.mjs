/**
 * MQTT 時戳新鮮度（傳輸統一 X2／X3，audit B6）：真的 mqtt.ts，stub 掉 mqtt.js、DB、裝置 id。
 *   X2 離線遺囑（LWT）的時戳是「連線當下」寫好的：裝置連線超過 5 分鐘後斷線，遺囑一到就被
 *      validateMessage 當成過期丟掉 → 其他裝置一直顯示它在線（只能等 150s staleness sweep），
 *      之後才訂閱的裝置也看不到 retained 的離線。現在 online:false 不擋時戳；online:true 照舊 5 分鐘。
 *   X3 AegisTrans 沒有群組控制訊息。配對信令（prekey_request／prekey_bundle）刻意維持 5 分鐘：
 *      裝置一連上就發 roster ping → 其他裝置 refreshDevices → 對沒 session 的裝置重發 PREKEY_REQUEST，
 *      不靠 broker 排隊；x3dh_init／encrypted_message 本來就是 24h。這裡把現況鎖住。
 *   另：無 listener 時暫存的「關鍵型別」清單把 prekey_bundle 拼成 pre_key_bundle → 只暫存 30 秒而非 120 秒。
 * Run: node scripts/check-mqtt-freshness.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/pwa/package.json'));
const dir = mkdtempSync(join(tmpdir(), 'mqttfresh-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^mqtt$|^\.\/database$|utils\/devLog$|utils\/diagLog$|^\.\/deviceId$|^\.\/apiBase$/ },
    (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === 'mqtt' ? 'export default { connect(){ throw new Error("no broker in test") } };'
    : a.path.endsWith('database') ? 'export async function getSetting(){ return null }'
    : a.path.endsWith('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.endsWith('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.endsWith('deviceId') ? 'export const getDeviceIdSync=()=>"0b6f4c1e8a2d4c3b";'
    : 'export const apiBase=()=>"/api";' }));
} };
await require('esbuild').build({ entryPoints: [join(root, 'packages/pwa/src/services/mqtt.ts')], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub] });
// 無 listener 的訊息會排一個丟棄 timer：不真的排（否則 node 要等 120s 才結束），回傳延遲值方便檢查
globalThis.setTimeout = (_fn, ms) => ms;
globalThis.clearTimeout = () => {};
console.warn = () => {}; console.error = () => {};
const { mqttService: svc } = await import(pathToFileURL(join(dir, 'm.mjs')));

svc.publicKeyBase64 = 'A'.repeat(44);
const B = 'B'.repeat(43) + '=';
const inbox = `mist/user/${'A'.repeat(44)}/inbox`;
const presence = `mist/user/${B.replace(/=+$/, '')}/presence`;
const min = 60_000;
const send = (topic, type, payload, ageMs) =>
  svc.handleMessage(topic, Buffer.from(JSON.stringify({ type, from: B, payload, timestamp: Date.now() - ageMs })));

// ── X2 ──
const changes = [];
svc.onPresenceChange((_key, online) => changes.push(online));
send(presence, 'presence', { online: true }, 0);
assert.equal(svc.isFriendOnline(B), true);
send(presence, 'presence', { online: false }, 40 * min);   // 40 分鐘前連線時寫好的遺囑，現在才觸發
assert.equal(svc.isFriendOnline(B), false, 'an offline will written at connect time (40 min ago) still marks the device offline');
assert.deepEqual(changes, [true, false]);
send(presence, 'presence', { online: true }, 10 * min);    // 舊的「在線」仍要擋，否則斷線的裝置會被復活
assert.equal(svc.isFriendOnline(B), false, 'a stale online presence is still ignored');
console.log('PASS offline will is honoured regardless of age; stale online still rejected');

// ── X3：durable 型別 24h；配對／WebRTC 信令照舊 5 分鐘（重新配對由 roster ping 觸發，不靠 broker 排隊）──
const got = [];
const types = ['x3dh_init', 'encrypted_message', 'prekey_request', 'prekey_bundle', 'webrtc_offer'];
const unsubs = types.map((t) => svc.onMessage(t, () => got.push(t)));
send(inbox, 'x3dh_init', { ephemeralPublicKey: 'E' }, 3 * 60 * min);   // 3 小時前送出，broker session 剛交付
send(inbox, 'encrypted_message', '{}', 3 * 60 * min);
send(inbox, 'prekey_request', {}, 10 * min);
send(inbox, 'prekey_bundle', { signedPreKeyPublic: 'S' }, 10 * min);
send(inbox, 'webrtc_offer', { sdp: 'x' }, 10 * min);
assert.deepEqual(got, ['x3dh_init', 'encrypted_message'], `24h for queued session setup, 5 min for signalling (got ${got.join(',')})`);
send(inbox, 'x3dh_init', { ephemeralPublicKey: 'E' }, 25 * 60 * min);
assert.equal(got.length, 2, 'older than the 24h broker session is still rejected');
unsubs.forEach((u) => u());
console.log('PASS x3dh_init / encrypted_message accepted for 24h; pairing & WebRTC signalling stay at 5 min');

// ── 關鍵型別暫存時間：prekey_bundle 與 x3dh_init／prekey_request 一樣暫存 120s ──
for (const t of ['x3dh_init', 'prekey_request', 'prekey_bundle', 'webrtc_answer']) send(inbox, t, {}, 0);
const kept = (t) => svc.pendingMessageTimers.get(t);
assert.equal(kept('x3dh_init'), 120_000);
assert.equal(kept('prekey_request'), 120_000);
assert.equal(kept('prekey_bundle'), 120_000, `prekey_bundle buffered as critical (got ${kept('prekey_bundle')}ms)`);
assert.equal(kept('webrtc_answer'), 30_000, 'non-critical types keep the 30s buffer');
console.log('PASS prekey_bundle buffered 120s like the other critical pairing messages');
