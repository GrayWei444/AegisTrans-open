/**
 * 同一個檔案請求重複送達（對應 TofuTalk 06442d1 → 8f00b1e，TofuTalk B7 + 審查 HIGH-1）：
 *   真的 services/fileTransfer.ts（esbuild；儲存、金鑰 stub 掉）。
 *   收端的 FILE_REQUEST 走 outbox，要等整個檔案傳完才回 ACK；傳送中 DataChannel 原地重開會再 flush 一次同一個請求。
 *   以前：每次都開一條新的完整串流 → 同一個檔案同時傳兩份以上。
 *   只「接上正在跑的那一條」也不行（TofuTalk 06442d1）：舊通道裡掉的 chunk 永遠不會重送，收端 60 秒後判失敗。
 *   現在：重複的請求先停掉正在跑的那一條（每塊、backpressure 等待中都檢查），再從第 0 塊重新開始；
 *   同一個 peer＋fileId 任何時候最多一條在送；先到的請求要等重新開始的那一條送完才算完成（才回 ACK）。
 * Run: node scripts/check-file-request-dedupe.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/pwa/package.json'));
const dir = mkdtempSync(join(tmpdir(), 'filereq-'));
const CHUNKS = 20;
globalThis.__keyCalls = 0;
globalThis.__releases = [];
globalThis.__gate = true;          // true：getActiveGroupKey 停住，等測試放行
const names = {
  './messageStore': `export const addMessage=async()=>{}; export const addReceivedMessage=async()=>true; export const updateMessage=async()=>{};
    export const findMessageByFileId=async()=>({ fileBlob: new Blob([new Uint8Array(${CHUNKS} * 65536)]) });`,
  './groupKey': `export async function getActiveGroupKey(){ globalThis.__keyCalls++;
      if (globalThis.__gate) await new Promise((r)=>{ globalThis.__releases.push(r); });
      return { keyId: 'k1', keyBase64: Buffer.alloc(32, 1).toString('base64') }; }
    export async function getGroupKeyById(){ return null; }`,
  './myDevicesGroup': 'export const myDevicesGroupId=(u)=>"g:"+u;',
  './groupKeyEnvelope': 'export const buildEncryptedEnvelopeOrGenerate=async()=>({}); export const ENVELOPE_PROTOCOL_VERSION=1;',
  './tierGate': 'export const checkUploadQuota=async()=>{}; export const checkSingleFileSize=async()=>"ok";',
  './nativeFileStream': 'export const getNativeFileStream=()=>null;',
  '../stores/subscriptionStore': 'export const useSubscriptionStore={ getState: () => ({}) };',
  '../utils/devLog': 'export const devLog=()=>{}; export const devWarn=()=>{};',
  '../utils/debugFlags': 'export const DEBUG_TOOLS=false;',
  './peerSync': 'export const sendFileRequest=async()=>{};',
};
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /.*/ }, (a) => (a.path in names ? { path: a.path, namespace: 's' } : undefined));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents: names[a.path] }));
} };
await require('esbuild').build({ entryPoints: [join(root, 'packages/pwa/src/services/fileTransfer.ts')], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'f.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
console.error = () => {};
const ft = await import(pathToFileURL(join(dir, 'f.mjs')));
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decodeIndex = (buf) => { const n = new DataView(buf).getUint32(0, true); return JSON.parse(Buffer.from(buf, 4, n).toString()).chunkIndex; };
const range = (n) => [...Array(n).keys()];
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what}: still pending after ${ms} ms`); })]);
// 每個測項重新接上 sendChunk／backpressure 的 hook（initFileTransfer 可重複呼叫）
const init = (sendChunk, getBufferedAmount) => ft.initFileTransfer({ userId: 'u1', currentDeviceId: 'd1', ownPubkey: 'ME',
  sendChunk, getBufferedAmount, sendJson: () => {}, getPeers: () => [] });

const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
};

await check('a duplicate request never runs in parallel with the running transfer; other requesters and later requests get their own', async () => {
  const wire = { PEER: [], OTHER: [] };
  init((peer, frame) => { wire[peer].push(decodeIndex(frame)); return true; });
  globalThis.__keyCalls = 0; globalThis.__gate = true;
  const first = ft.handleFileRequest('file-1', 'PEER');
  await tick();
  const dup = ft.handleFileRequest('file-1', 'PEER');     // DataChannel 重開，outbox 又送一次
  await tick();
  assert.equal(globalThis.__keyCalls, 1, 'the duplicate must wait for the running transfer to stop (no parallel stream)');
  const other = ft.handleFileRequest('file-1', 'OTHER');  // 另一台要同一個檔案：照常傳
  await tick();
  assert.equal(globalThis.__keyCalls, 2, 'a different requester still gets its own transfer');
  globalThis.__gate = false;
  globalThis.__releases.splice(0).forEach((r) => r());
  await withTimeout(Promise.all([first, dup, other]), 5000, 'transfers');
  assert.deepEqual(wire.PEER, range(CHUNKS), `PEER got one full stream in order (got [${wire.PEER.join(',')}])`);
  assert.deepEqual(wire.OTHER, range(CHUNKS), 'OTHER got its own full stream');
  wire.PEER.length = 0;
  const callsBefore = globalThis.__keyCalls;
  await withTimeout(ft.handleFileRequest('file-1', 'PEER'), 5000, 'later request');  // 傳完之後再要：重新開始
  assert.equal(globalThis.__keyCalls, callsBefore + 1, 'after the transfer ends, a new request starts a new transfer');
  assert.deepEqual(wire.PEER, range(CHUNKS));
});

await check('chunks lost in the old channel are re-sent: the duplicate restarts the stream from chunk 0 (review HIGH-1 / probe2)', async () => {
  // 舊通道在第 4 塊之後變成黑洞（第 5–9 塊遺失），第 9 塊時新通道開好 → outbox 重送同一個 FILE_REQUEST
  globalThis.__gate = false;
  const delivered = new Set();
  const afterDup = [];
  let blackHole = false; let reopened = false; let dup = null; let firstDoneWith = null;
  init((_peer, frame) => {
    const i = decodeIndex(frame);
    if (reopened) afterDup.push(i);
    if (!blackHole) delivered.add(i);
    if (i === 4 && !reopened) blackHole = true;
    if (i === 9 && !reopened) { reopened = true; blackHole = false; dup = ft.handleFileRequest('file-2', 'PEER'); }
    return true;
  });
  const first = ft.handleFileRequest('file-2', 'PEER').then(() => { firstDoneWith = delivered.size; });
  await withTimeout(first, 5000, 'first request');
  await withTimeout(dup, 5000, 'duplicate request');
  const missing = range(CHUNKS).filter((i) => !delivered.has(i));
  assert.deepEqual(missing, [], `requester still missing chunks [${missing.join(',')}] → stalls 60 s, then fails`);
  assert.deepEqual(afterDup, range(CHUNKS), `after the duplicate exactly one fresh stream 0..${CHUNKS - 1} (got [${afterDup.join(',')}])`);
  assert.equal(firstDoneWith, CHUNKS, 'the first request completes (→ ACK) only after the restarted stream delivered everything');
});

await check('a manual retry while a stream waits on backpressure stops it at once and restarts', async () => {
  globalThis.__gate = false;
  let high = false; const wire = [];
  init((_peer, frame) => { const i = decodeIndex(frame); wire.push(i); if (i === 2 && wire.length === 3) high = true; return true; },
    () => (high ? 8 * 1024 * 1024 : 0));
  const first = ft.handleFileRequest('file-3', 'PEER');
  await sleep(150);
  assert.ok(high && wire.length === 3, `the old stream is waiting on backpressure after chunk 2 (sent [${wire.join(',')}])`);
  const calls = globalThis.__keyCalls;
  const retry = ft.handleFileRequest('file-3', 'PEER');
  await sleep(300);
  assert.equal(globalThis.__keyCalls, calls + 1, 'the old stream left its backpressure wait and the fresh one started (buffer still full)');
  high = false;
  await withTimeout(Promise.all([first, retry]), 5000, 'transfers');
  assert.deepEqual(wire, [0, 1, 2, ...range(CHUNKS)], `old stream sent nothing after the retry (got [${wire.join(',')}])`);
});

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall FILE_REQUEST duplicate checks passed');
