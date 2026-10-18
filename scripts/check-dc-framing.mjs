/**
 * DataChannel 大訊息分塊（傳輸統一 X5）：真的 webrtc.ts／p2pSend.ts／dcFraming.ts。
 *   Chromium（含 Electron、Android WebView）的 SCTP 單則上限約 256KB，超過時 RTCDataChannel.send() 直接 throw
 *   → webrtc.send 回 false。文字訊息沒有長度上限：貼一段約 190KB 以上的文字，加密 envelope（base64）就超過；
 *   訊息先進 outbox，flushQueueForPeer 遇到第一筆送不出去就停 → 該裝置之後的訊息全部卡住 30 天（outbox TTL）。
 *   現在：超過上限的字串自動切塊、收端重組（不切斷 emoji）；收端有上限防灌爆；
 *   outbox 裡永遠送不出去（> 8M 字元）的條目會被移除，不再擋住後面的訊息，新的也不收。
 *   新舊版混用：舊版收端不認得分塊幀，舊版直接 send() 送得到的大小（對端宣告的上限；拿不到 sctp 時 256KB）
 *   照舊單幀送，只有單幀 send 丟錯時才改分塊（對應 AegisPlay 85480698）。
 * Run: node scripts/check-dc-framing.mjs
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
const esbuild = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'dcframe-'));
const utf8 = (s) => Buffer.byteLength(s, 'utf8');
const CAP = 8 * 1024 * 1024;           // 單則訊息硬上限（dcFraming.DC_MAX_MESSAGE_CHARS，第 3 段核對）
const CHROMIUM_LIMIT = 256 * 1024;      // Chromium 宣告的 SCTP max-message-size
const stubPlugin = (filter, contents) => ({ name: 'stub', setup(b) {
  b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents: contents(a.path) }));
} });
const logStub = (p) => (p.endsWith('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
  : p.endsWith('diagLog') ? 'export const diagLog=()=>{};' : null);
console.error = () => {};
console.warn = () => {};

const bigText = JSON.stringify({ v: 1, kind: 'encrypted_text', keyId: 'k', iv: 'i', ciphertext: 'Q'.repeat(1_000_000), mid: 'p2p_big' });

// ── 1. 真的 webrtc.ts：send 切塊、onmessage 重組 ──
await esbuild.build({ entryPoints: [src('services/webrtc.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'w.mjs'), logLevel: 'silent',
  plugins: [stubPlugin(/utils\/devLog$|utils\/diagLog$|utils\/debugFlags$|^\.\/mqtt$|^\.\/iceServers$/, (p) => logStub(p)
    ?? (p.endsWith('debugFlags') ? 'export const DEBUG_TOOLS=false;'
    : p.endsWith('mqtt') ? `export const MessageType={WEBRTC_OFFER:'o',WEBRTC_ANSWER:'a',WEBRTC_ICE:'i',SCREEN_SHARE_ICE:'s'};
        export const mqttService={onMessage:()=>()=>{},isConnected:()=>true,sendToUser(){}};`
    : 'export async function getIceServers(){return []}'))] });
const { webrtcService: rtc } = await import(pathToFileURL(join(dir, 'w.mjs')));
const wire = [];
const PK = 'P'.repeat(44);
const dc = { readyState: 'open', bufferedAmount: 0, send: (d) => {
  const n = typeof d === 'string' ? utf8(d) : d.byteLength;
  if (n > CHROMIUM_LIMIT) throw new TypeError('RTCDataChannel message too large');
  wire.push(d);
} };
rtc.peers.set(PK, { publicKeyBase64: PK, connection: { sctp: { maxMessageSize: CHROMIUM_LIMIT }, connectionState: 'connected' },
  dataChannel: dc, connectionState: 'connected', dataChannelState: 'open', isInitiator: true,
  pendingCandidates: [], candidateFlushTimer: null, incomingCandidates: [] });
assert.equal(rtc.send(PK, bigText), true, 'a ~1 MB text envelope is accepted by send() (Chromium throws above 256 KB)');
assert.ok(wire.length > 1 && wire.every((f) => utf8(f) <= CHROMIUM_LIMIT), `went out as several frames that fit (${wire.length})`);
const got = [];
rtc.onMessage((_pk, data) => got.push(data));
const rx = {};
rtc.setupDataChannel(rx, PK);
for (const d of wire) rx.onmessage({ data: d });
assert.deepEqual(got, [bigText], 'the receiver delivers exactly one reassembled message');
const frames = wire.length;

wire.length = 0; got.length = 0;
const ack = JSON.stringify({ kind: '__ack', mid: 'p2p_x' });
assert.equal(rtc.send(PK, ack), true);
assert.deepEqual(wire, [ack], 'small messages go out unchanged (older peers keep working)');
const chunk = new ArrayBuffer(70_000);
assert.equal(rtc.send(PK, chunk), true);
assert.equal(wire[1], chunk, 'binary file chunks are not framed');
rx.onmessage({ data: '{"type":"__dc_hb"}' });
rx.onmessage({ data: ack });
assert.deepEqual(got, [ack], 'heartbeat still swallowed; normal frames delivered as-is');
console.log(`PASS webrtc.ts send/receive (${frames} frames → 1 message; small/binary unchanged)`);

// 新舊版混用：舊版收端不認得分塊幀，舊版直接 send() 送得到的大小必須照舊單幀送
const sendWith = (connection, size, sendLimit = CHROMIUM_LIMIT) => {
  const out = [];
  const chan = { readyState: 'open', bufferedAmount: 0, send: (d) => {
    if (utf8(d) > sendLimit) throw new TypeError('RTCDataChannel message too large');
    out.push(d);
  } };
  rtc.peers.set(PK, { publicKeyBase64: PK, connection, dataChannel: chan, connectionState: 'connected',
    dataChannelState: 'open', isInitiator: true, pendingCandidates: [], candidateFlushTimer: null, incomingCandidates: [] });
  const msg = JSON.stringify({ v: 1, kind: 'encrypted_text', ciphertext: 'x'.repeat(size), mid: 'p2p_mixed' });
  return { ok: rtc.send(PK, msg), frames: out, msg };
};
let r = sendWith({ sctp: { maxMessageSize: CHROMIUM_LIMIT } }, 248 * 1024);
assert.ok(r.ok && r.frames.length === 1 && r.frames[0] === r.msg,
  `248KB (old senders sent it whole) still goes out as one frame (got ${r.frames.length})`);
r = sendWith({}, 100 * 1024);
assert.ok(r.ok && r.frames.length === 1, `no sctp info: 100KB is not chunked (old peers could receive it) (got ${r.frames.length})`);
r = sendWith({ sctp: null }, 200 * 1024);
assert.ok(r.ok && r.frames.length === 1, `sctp null (ICE blip): 200KB is not chunked (got ${r.frames.length})`);
r = sendWith({ sctp: { maxMessageSize: 1 << 30 } }, 300 * 1024);
assert.ok(r.ok && r.frames.length > 1 && r.frames.every((f) => utf8(f) <= CHROMIUM_LIMIT),
  'peer advertises more than this side can send → the single-frame send throws and it falls back to chunks');
const back = [];
const off = rtc.onMessage((_pk, data) => back.push(data));
const rx2 = {};
rtc.setupDataChannel(rx2, PK);
for (const d of r.frames) rx2.onmessage({ data: d });
assert.ok(back.includes(r.msg), 'and the fallback chunks reassemble');
off();
r = sendWith({ sctp: null }, 300 * 1024);
assert.ok(r.ok && r.frames.length > 1, 'above 256KB with no sctp info → still chunked (old peers never received these)');
console.log('PASS mixed versions: sizes old peers could receive stay single-frame');

// ── 2. p2pSend：超大舊條目不再擋住後面 ──
const DB_FNS = ['addPendingMessage', 'getPendingMessagesForRecipient', 'getAllPendingMessages', 'removePendingMessage',
  'updatePendingMessageRetry', 'getPendingMessageCount', 'getPendingMessageStats', 'deletePendingMessagesForRecipient',
  'cleanupOldPendingMessages', 'getPendingRecipients'];
await esbuild.build({ entryPoints: [src('services/p2pSend.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'p.mjs'), logLevel: 'silent',
  plugins: [stubPlugin(/utils\/devLog$|utils\/diagLog$|^\.\/database$/, (p) => logStub(p)
    ?? DB_FNS.map((f) => `export const ${f}=(...a)=>globalThis.__db.${f}(...a);`).join('\n'))] });
let pending = [];
globalThis.__db = {
  getPendingMessageCount: async (peer) => pending.filter((m) => m.recipientPubkey === peer).length,
  addPendingMessage: async (m) => { pending.push(m); },
  getPendingMessagesForRecipient: async (peer) => pending.filter((m) => m.recipientPubkey === peer),
  getAllPendingMessages: async () => pending,
  removePendingMessage: async (id) => { pending = pending.filter((m) => m.id !== id); },
  updatePendingMessageRetry: async () => {},
  getPendingRecipients: async () => [...new Set(pending.map((m) => m.recipientPubkey))],
};
const api = await import(pathToFileURL(join(dir, 'p.mjs')));
const sent = [];
// 與修正後的 webrtc.send 一致：超過硬上限回 false，其他照送
api.registerP2PFunctions({ isConnectedTo: () => true, connectPeer: async () => {},
  sendToPeer: (_p, d) => { if (d.length > CAP) return false; sent.push(d); return true; } });
const huge = JSON.stringify({ v: 1, kind: 'encrypted_text', ciphertext: 'z'.repeat(CAP + 10), mid: 'old-huge' });
const next = JSON.stringify({ v: 1, kind: 'encrypted_text', ciphertext: 'x', mid: 'next' });
pending.push({ id: 'old-huge', recipientPubkey: 'peer', encryptedPayload: huge, messageType: 'p2p', createdAt: 1, retryCount: 0 });
pending.push({ id: 'next', recipientPubkey: 'peer', encryptedPayload: next, messageType: 'p2p', createdAt: 2, retryCount: 0 });
await api.flushQueueForPeer('peer');
assert.deepEqual(sent, [next], 'the message behind an undeliverable giant is sent');
assert.deepEqual(pending.map((m) => m.id), ['next'], 'the giant is removed from the outbox; the sent one waits for its ACK');
assert.equal(await api.sendViaP2P('peer', huge), false, 'a new giant is refused');
assert.equal(pending.length, 1, 'and never enters the outbox');
assert.equal(await api.sendViaP2P('peer', bigText), true, 'a ~1 MB message is still persisted and sent');
assert.equal(pending.length, 2);
console.log('PASS outbox no longer blocks behind an oversized entry');

// ── 3. dcFraming 本身 ──
await esbuild.build({ entryPoints: [src('services/dcFraming.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'f.mjs'), logLevel: 'silent' });
const F = await import(pathToFileURL(join(dir, 'f.mjs')));
assert.equal(F.DC_MAX_MESSAGE_CHARS, CAP, 'hard cap is 8M characters');
const LIMIT = 240 * 1024;
const small = JSON.stringify({ v: 1, kind: 'encrypted_text', ciphertext: 'x'.repeat(1000) });
assert.deepEqual(F.splitFrame(small, LIMIT), [small], 'small messages go out unchanged');
const parts = F.splitFrame(bigText, LIMIT);
assert.ok(parts.length > 1 && parts.every((p) => utf8(p) <= LIMIT), `every part fits the limit (${parts.length} parts)`);
let asm = new F.FrameAssembler();
let out;
for (const p of parts) out = asm.push(p);
assert.equal(out, bigText, 'reassembles exactly');
const cjk = ('跨裝置同步😀測試' + 'é').repeat(60_000);
const cparts = F.splitFrame(cjk, LIMIT);
assert.ok(cparts.every((p) => utf8(p) <= LIMIT), 'multi-byte text parts fit the byte limit');
const body = (p) => p.split('|').slice(4).join('|');   // 去掉 "\u0001P|id|seq|count|" 標頭
assert.ok(cparts.every((p) => !/^[\uDC00-\uDFFF]/.test(body(p)) && !/[\uD800-\uDBFF]$/.test(body(p))), 'no part splits an emoji surrogate pair');
asm = new F.FrameAssembler();
for (const p of cparts) out = asm.push(p);
assert.equal(out, cjk, 'reassembles multi-byte text exactly');
assert.equal(F.splitFrame('x'.repeat(CAP + 1), LIMIT), null, 'over the hard cap → refused');
const mid = 'x'.repeat(250 * 1024);
assert.deepEqual(F.splitFrame(mid, LIMIT, CHROMIUM_LIMIT), [mid], 'up to singleMaxBytes it stays one frame');
assert.ok(F.splitFrame(mid, LIMIT).length > 1 && F.splitFrame(mid, LIMIT).every((p) => utf8(p) <= LIMIT),
  'without singleMaxBytes the part limit applies');
console.log(`PASS split/reassemble (${parts.length} parts for ${(bigText.length / 1e6).toFixed(1)}M chars; emoji-safe)`);

// 收端防灌爆
asm = new F.FrameAssembler();
assert.equal(asm.push(small), undefined, 'normal frames pass through');
assert.equal(asm.push('\u0001P|a|0|0|x'), null, 'count 0 rejected');
assert.equal(asm.push('\u0001P|a|5|3|x'), null, 'seq out of range rejected');
assert.equal(asm.push('\u0001P|a|0|99999|x'), null, 'absurd part count rejected');
assert.equal(asm.size, 0, 'rejected frames leave no state');
for (let i = 0; i < 10; i++) asm.push(`\u0001P|id${i}|0|2|x`);
assert.ok(asm.size <= 4, `at most 4 messages in assembly per peer (got ${asm.size})`);
let clock = 0;
asm = new F.FrameAssembler(() => clock);
asm.push('\u0001P|t|0|2|a');
clock = 61_000;
asm.push('\u0001P|u|0|2|b');
assert.equal(asm.push('\u0001P|t|1|2|c'), null, 'an assembly older than 60s is dropped');
const big = 'y'.repeat(3_000_000);
for (let s = 0; s < 3; s++) asm.push(`\u0001P|huge|${s}|4|${big}`);
assert.ok(asm.bufferedChars <= CAP, 'buffered characters capped');
console.log('PASS receiver limits (bad frames, concurrency, 60s expiry, size cap)');
