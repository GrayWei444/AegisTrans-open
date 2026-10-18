/**
 * 廣播頻道不再跨帳號（稽核 B2，對應 TofuTalk 0286221 的 client 部分）：真的 mqtt.ts（stub 掉 mqtt.js 與網路）。
 *   以前每個 client 都訂 `mist/broadcast`、broadcast() 也發到那裡，而伺服器發給「每個帳號」的通行證都准讀寫這條；
 *   handleMessage 只看 type 不看 topic → 任何帳號的任何人都能對全世界在線的 client 送任何 MessageType、`from` 隨便填
 *   （PREKEY_REQUEST 放大、SCREEN_SHARE_OFFER 彈窗、偽造 X3DH_INIT{sessionReset} 拆 session、標記任意公鑰上線…）。
 *   AegisTrans 沒有任何正當程式發到這條。
 *   現在：帳號已知時廣播頻道是 `mist/acct/{userId}/broadcast`（帳號 ACL `mist/acct/{userId}/#` 本來就涵蓋）；
 *   只有沒有帳號的 dev broker 才用舊名稱。
 * Run: node scripts/check-mqtt-broadcast-scope.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/pwa/package.json'));
const dir = mkdtempSync(join(tmpdir(), 'aegistrans-bcast-'));
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
const { mqttService: svc, MessageType } = await import(pathToFileURL(join(dir, 'm.mjs')));

const subscribed = [];
const published = [];
svc.publicKeyBase64 = 'A'.repeat(43) + '=';
svc.accountUserId = 'u1';
svc.client = {
  connected: true,
  subscribe: (topic) => subscribed.push(topic),
  unsubscribe: () => {},   // 連上時退訂舊的全域 topic（check-mqtt-topic-scope.mjs 檢查）
  publish: (topic) => published.push(topic),
};
svc.subscribeToDefaultTopics();
svc.stopPresenceHeartbeat?.(); svc.stopPresenceStaleSweep?.();   // 只看訂閱，不留計時器
svc.broadcast(MessageType.PRESENCE, { online: true });

const all = [...subscribed, ...published];
assert.ok(!all.includes('mist/broadcast'), `nothing is subscribed or published on the global mist/broadcast topic (got ${JSON.stringify(all)})`);
assert.ok(all.every((t) => t.startsWith('mist/acct/u1/')), `every default topic stays inside the account (got ${JSON.stringify(all)})`);
assert.equal(published.at(-1), 'mist/acct/u1/broadcast', 'broadcast() publishes on the account-scoped channel');
console.log('PASS the broadcast channel is scoped to the account; no global mist/broadcast subscription');
