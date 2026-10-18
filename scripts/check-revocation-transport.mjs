/**
 * 被撤銷的裝置不能再連上、收發（稽核 B1、B10，對應 TofuTalk f66a043）：真的 webrtc.ts（offer 入站閘門）與
 * peerSync.ts（stub 掉其餘模組）。
 *   以前 offer 對任何 from 都接、DataChannel 內容不查是誰、knownPeerPubkeys 從不刪：
 *   被撤的裝置仍能重建 DataChannel、注入訊息、要檔案（FILE_REQUEST），其他裝置也一直對它廣播新訊息。
 *   現在：offer 與入站內容都要是本帳號裝置（入站逐 peer 串列，檔案 chunk 不亂序）；裝置清單更新時把不在清單上的
 *   peer 移除、斷線（空清單不動作）；給它的 outbox 要連續兩次成功的清單（相隔 ≥ 60 秒）都沒有它才清
 *   （對應 TofuTalk a08cc93，審查 LOW）。
 * Run: node scripts/check-revocation-transport.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'packages/pwa/src');
const require = createRequire(join(root, 'packages/pwa/package.json'));
const esbuild = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'revtrans-'));
const tick = () => new Promise((r) => setTimeout(r, 0));
console.error = () => {};

// ── 1. webrtc.ts：offer 入站閘門 ──
globalThis.__h = {};
const rtcStub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /utils\/devLog$|utils\/diagLog$|^\.\/mqtt$|^\.\/iceServers$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('mqtt') ? `export const MessageType = new Proxy({}, { get: (_, k) => String(k) });
        export const mqttService = { onMessage: (t, f) => { globalThis.__h[t] = f; return () => {}; }, isConnected: () => true, sendToUser() {} };`
    : 'export async function getIceServers(){ return [] }' }));
} };
await esbuild.build({ entryPoints: [join(src, 'services/webrtc.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'w.mjs'), logLevel: 'silent', plugins: [rtcStub], define: { 'import.meta.env': '{}' } });
globalThis.localStorage = { getItem: () => null };
const { webrtcService: rtc } = await import(pathToFileURL(join(dir, 'w.mjs')));
const built = [];
rtc.createResponderConnection = async (pk) => { built.push(pk); };
rtc.initialize('ME');
assert.equal(typeof rtc.setInboundPolicy, 'function', 'webrtc exposes an inbound offer policy');
rtc.setInboundPolicy(async (pk) => pk === 'GOOD');
await globalThis.__h.WEBRTC_OFFER({ from: 'REVOKED', payload: { type: 'offer', sdp: 'x' } });
await globalThis.__h.WEBRTC_OFFER({ from: 'GOOD', payload: { type: 'offer', sdp: 'x' } });
assert.deepEqual(built, ['GOOD'], 'an offer from a device no longer on the account is rejected');
rtc.shutdown();
console.log('PASS webrtc inbound offers limited by policy');

// ── 2. peerSync.ts：入站內容、修剪 ──
const ev = globalThis.__ps = { acks: [], chunks: [], fileRequests: [], disconnected: [], cleared: [], outbox: [], policy: null, onMessage: null };
const names = {
  './mqtt': 'export const mqttService = { onPresenceChange: () => () => {} };',
  './webrtc': `export const DataChannelState = { OPEN: 'open' };
    export const webrtcService = { initialize() {}, shutdown() {}, onMessage: (cb) => { globalThis.__ps.onMessage = cb; return () => {}; },
      onDataChannelStateChange: () => () => {}, setInboundPolicy: (p) => { globalThis.__ps.policy = p; },
      connect: async () => {}, disconnect: (pk) => globalThis.__ps.disconnected.push(pk), isDataChannelOpen: () => false, isPeerFailed: () => false, isPeerHealthy: () => true, send: () => true };`,
  './peerHealthMonitor': 'export const peerHealthMonitor = { start() {}, stop() {} };',
  './p2pSend': `export const registerP2PFunctions=()=>{}; export const unregisterP2PFunctions=()=>{}; export const sendViaP2P=()=>{};
    export const flushQueueForPeer=async()=>0; export const notifyConnectSuccess=()=>{}; export const loadOutbox=async()=>{};
    export const ackDelivered=(mid)=>globalThis.__ps.acks.push(mid); export const sendAckToPeer=()=>{};
    export const outboxRecipients=async()=>[...globalThis.__ps.outbox];
    export const clearOutboxForPeer=async(pk)=>{ globalThis.__ps.cleared.push(pk); return 1; };
    /* 舊 API（一次快照就清）：修正後 peerSync 不該再呼叫 */
    export const clearOutboxExcept=async(keep)=>{ globalThis.__ps.cleared.push('clearOutboxExcept:' + [...keep].sort().join(',')); return 0; };`,
  './messageStore': 'export const addMessage=async()=>{}; export const addReceivedMessage=async()=>({ inserted: true }); export const deleteMessage=async()=>{};',
  './fileTransfer': `export const initFileTransfer=()=>{}; export const shutdownFileTransfer=()=>{}; export const handleManifest=async()=>true;
    export const handleChunkFrame=async(buf, peer)=>{ globalThis.__ps.chunks.push(peer + ':' + new Uint8Array(buf)[0]); }; export const onFileReceived=()=>()=>{};
    export const handleFileRequest=async(fileId, peer)=>{ globalThis.__ps.fileRequests.push(peer + ':' + fileId); };`,
  './groupKeyEnvelope': `export const ENVELOPE_PROTOCOL_VERSION=1; export const buildEncryptedEnvelope=async()=>({}); export const buildEncryptedEnvelopeOrGenerate=async()=>({});
    export const decryptEnvelope=async(env)=>(env.kind === 'encrypted_file_request' ? { fileId: 'F1' } : null);`,
  '../utils/diagLog': 'export const diagLog=()=>{};',
  '../utils/devLog': 'export const devLog=()=>{}; export const devWarn=()=>{};',
  '../utils/debugFlags': 'export const DEBUG_TOOLS=false;',
};
const psStub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /.*/ }, (a) => (a.path in names ? { path: a.path, namespace: 's' } : undefined));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents: names[a.path] }));
} };
await esbuild.build({ stdin: { contents: `export * from './services/peerSync.ts'; export { setAccountDeviceCheck } from './services/accountDevices.ts';`,
  resolveDir: src, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'p.mjs'), logLevel: 'silent', plugins: [psStub] });
const ps = await import(pathToFileURL(join(dir, 'p.mjs')));
ps.initPeerSync({ localPubkeyBase64: 'ME', currentDeviceId: 'd-me', userId: 'u1' });
ps.setAccountDeviceCheck(async (pk) => pk === 'GOOD');
assert.equal(typeof ev.policy, 'function', 'peerSync installs the inbound offer policy');
assert.equal(await ev.policy('REVOKED'), false);

const fileReq = JSON.stringify({ v: 1, kind: 'encrypted_file_request', keyId: 'k', iv: 'i', ciphertext: 'c' });
ev.onMessage('REVOKED', JSON.stringify({ kind: '__ack', mid: 'r1' }));
ev.onMessage('REVOKED', new Uint8Array([9]).buffer);
ev.onMessage('REVOKED', fileReq);
for (let i = 1; i <= 3; i++) ev.onMessage('GOOD', new Uint8Array([i]).buffer);
ev.onMessage('GOOD', JSON.stringify({ kind: '__ack', mid: 'g1' }));
ev.onMessage('GOOD', fileReq);
for (let i = 0; i < 20; i++) await tick();
assert.deepEqual(ev.acks, ['g1'], 'frames from a revoked device are dropped');
assert.deepEqual(ev.fileRequests, ['GOOD:F1'], 'a revoked device cannot request files');
assert.deepEqual(ev.chunks, ['GOOD:1', 'GOOD:2', 'GOOD:3'], 'account devices still deliver, chunks in order');
console.log('PASS inbound DataChannel data only from account devices, order kept');

await ps.connectToPeers(['GOOD', 'REVOKED']);
assert.equal(typeof ps.pruneToAccountPeers, 'function', 'peerSync can prune peers that left the account');
assert.deepEqual(ps.pruneToAccountPeers([]), [], 'an empty list (fetch failed) prunes nobody');
assert.deepEqual(ps.pruneToAccountPeers(['GOOD', 'ME']), ['REVOKED'], 'peers no longer on the account are pruned');
assert.ok(ev.disconnected.includes('REVOKED') && !ev.disconnected.includes('GOOD'), 'and disconnected');
await tick();
console.log('PASS device-list update prunes revoked peers (broadcast targets, connections) at once');

// 審查 LOW（TofuTalk a08cc93）：一次清單快照就刪 outbox → 清單偶發少一台時，排隊中的訊息直接消失。
// AegisTrans 審查 D（8643656；對應 TofuTalk c0fe806）：舊伺服器（660fdbb 之前）把同指紋的兩台合併成一筆，其中一台的公鑰不在
//   任何一筆上；它下次開 App（新伺服器）才會有自己的一筆。60 秒後就刪 outbox → 給它的排隊訊息就沒了。現在要連續 24 小時、
//   每次成功的清單都沒有它才刪（outbox 本身 30 天到期）；自己撤銷的那台由撤銷流程立刻清（App.tsx），斷線、不收入站照舊立刻做。
const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
};
const realNow = Date.now;
const HOUR = 3_600_000;
await check('outbox is deleted only after 24 h of continuous absence from successful lists (not after 60 s)', async () => {
  assert.deepEqual(ev.cleared, [], `pruneToAccountPeers must not touch the outbox (cleared: ${ev.cleared.join(' | ')})`);
  assert.equal(typeof ps.observeAccountDeviceList, 'function', 'peerSync.observeAccountDeviceList does not exist');
  let now = 5_000_000; Date.now = () => now;
  ev.outbox = ['GOOD', 'GONE'];
  await ps.observeAccountDeviceList([]);                         // 空清單＝沒抓到，不算一次
  await ps.observeAccountDeviceList(['GOOD', 'ME']);             // GONE 第 1 次不在
  assert.deepEqual(ev.cleared, [], 'one snapshot never deletes queued messages');
  now += 61_000; await ps.observeAccountDeviceList(['GOOD', 'ME']);
  assert.deepEqual(ev.cleared, [], 'missing for a minute: kept (an old merged row; the device registers on its next start)');
  now += 23 * HOUR; await ps.observeAccountDeviceList(['GOOD', 'ME']);
  assert.deepEqual(ev.cleared, [], 'missing for ~23 h: kept');
  now += HOUR; await ps.observeAccountDeviceList(['GOOD', 'ME']);
  assert.deepEqual(ev.cleared, ['GONE'], 'missing from every list for 24 h: its outbox is cleared');
  ev.cleared.length = 0; ev.outbox = ['GOOD', 'BACK'];
  await ps.observeAccountDeviceList(['GOOD', 'ME']);
  now += 20 * HOUR; await ps.observeAccountDeviceList(['GOOD', 'ME', 'BACK']);   // 回來了 → 重新計算
  now += 20 * HOUR; await ps.observeAccountDeviceList(['GOOD', 'ME']);
  assert.deepEqual(ev.cleared, [], 'a device that reappeared starts over');
  now += 20 * HOUR; await ps.observeAccountDeviceList(['GOOD', 'ME']);
  assert.deepEqual(ev.cleared, [], '20 h since it went missing again: kept');
  now += 4 * HOUR; await ps.observeAccountDeviceList(['GOOD', 'ME']);
  assert.deepEqual(ev.cleared, ['BACK']);
});
Date.now = realNow;
ps.shutdownPeerSync();   // 停掉 peerSync 的計時器，程序才會結束
if (failures.length) { console.log(`\n${failures.length} check(s) failed`); process.exit(1); }
