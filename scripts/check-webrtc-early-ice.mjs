/**
 * offer 還在等「是不是自己的裝置」時先到的 ICE 不能丟（AegisTrans 審查 C；對應 TofuTalk afc85e8）：真的 webrtc.ts，
 *   RTCPeerConnection 換成假的（記下 addIceCandidate）。
 *   handleOffer 先 await inbound policy 才建 peer；對方 100 ms 後 trickle 的 ICE 到的時候還沒有這個 peer → 以前直接丟，
 *   restrictive NAT 後面的 P2P 重啟後就連不上（缺候選，卡 checking）。
 *   現在：不認得的 peer 的 ICE 先存起來（每台最多 32 個、最多 30 秒），建 responder 時補上；policy 拒絕就丟掉。
 * Run: node scripts/check-webrtc-early-ice.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname;
const src = root + 'packages/pwa/src/';
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'earlyice-'));
console.error = () => {};
globalThis.__h = {};
globalThis.__sent = [];
const rtcStub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /utils\/devLog$|utils\/diagLog$|^\.\/mqtt$|^\.\/iceServers$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('mqtt') ? `export const MessageType = new Proxy({}, { get: (_, k) => String(k) });
        export const mqttService = { onMessage: (t, f) => { globalThis.__h[t] = f; return () => {}; }, isConnected: () => true,
          sendToUser() {}, sendAnswer: (to, a) => globalThis.__sent.push(['answer', to]), sendIceCandidate() {}, sendOffer() {} };`
    : 'export function getIceServers(){ return [] }' }));
} };
await require('esbuild').build({ entryPoints: [src + 'services/webrtc.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'w.mjs'), logLevel: 'silent', plugins: [rtcStub], define: { 'import.meta.env': '{}' } });

const pcs = [];
class FakePC {
  constructor() { this.added = []; this.remoteDescription = null; this.signalingState = 'stable'; this.connectionState = 'new';
    this.iceConnectionState = 'new'; pcs.push(this); }
  async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = 'have-remote-offer'; }
  async createAnswer() { return { type: 'answer', sdp: 'a' }; }
  async setLocalDescription() { this.signalingState = 'stable'; }
  async addIceCandidate(c) { if (!this.remoteDescription) throw new Error('remote description was null'); this.added.push(c.candidate ?? c); }
  createDataChannel() { return { readyState: 'connecting', close() {} }; }
  getSenders() { return []; } getReceivers() { return []; } close() { this.closed = true; }
}
globalThis.RTCPeerConnection = FakePC;
globalThis.RTCSessionDescription = class { constructor(d) { Object.assign(this, d); } };
globalThis.RTCIceCandidate = class { constructor(c) { Object.assign(this, c); } };
globalThis.localStorage = { getItem: () => null };
const { webrtcService: rtc } = await import(pathToFileURL(join(dir, 'w.mjs')));
rtc.initialize('ME');

const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const ice = (from, n) => globalThis.__h.WEBRTC_ICE({ from, payload: { candidate: `cand-${n}`, sdpMid: '0', sdpMLineIndex: 0 } });

await check('ICE that arrives while the offer waits for the account check is applied to the responder connection', async () => {
  const gate = deferred();
  rtc.setInboundPolicy(() => gate.promise);                 // GET /devices 還在路上
  const offer = globalThis.__h.WEBRTC_OFFER({ from: 'PEER1', payload: { type: 'offer', sdp: 'x' } });
  await tick();
  await ice('PEER1', 1); await ice('PEER1', 2);              // 對方 100 ms 後 trickle 的候選
  gate.resolve(true);
  await offer; await tick();
  const pc = pcs.at(-1);
  assert.ok(pc && pc.remoteDescription, 'a responder connection was built');
  assert.deepEqual(pc.added, ['cand-1', 'cand-2'], `candidates added: [${pc?.added.join(', ')}]`);
  await ice('PEER1', 3);
  assert.deepEqual(pc.added, ['cand-1', 'cand-2', 'cand-3'], 'later candidates go straight in');
  rtc.closePeer?.('PEER1');
});

await check('early ICE is bounded (32 per peer), dropped after ~30 s, and discarded when the policy refuses the offer', async () => {
  const gate = deferred();
  rtc.setInboundPolicy(() => gate.promise);
  const offer = globalThis.__h.WEBRTC_OFFER({ from: 'PEER2', payload: { type: 'offer', sdp: 'x' } });
  await tick();
  for (let i = 0; i < 40; i++) await ice('PEER2', i);
  gate.resolve(true);
  await offer; await tick();
  assert.equal(pcs.at(-1).added.length, 32, `kept ${pcs.at(-1).added.length} of 40`);
  rtc.closePeer?.('PEER2');

  const realNow = Date.now;
  const late = deferred();
  rtc.setInboundPolicy(() => late.promise);
  const slow = globalThis.__h.WEBRTC_OFFER({ from: 'PEER3', payload: { type: 'offer', sdp: 'x' } });
  await tick();
  await ice('PEER3', 'old');
  Date.now = () => realNow() + 31_000;
  try {
    late.resolve(true);
    await slow; await tick();
  } finally { Date.now = realNow; }
  assert.deepEqual(pcs.at(-1).added, [], 'candidates older than ~30 s are not used');
  rtc.closePeer?.('PEER3');

  const refused = deferred();
  const before = pcs.length;
  rtc.setInboundPolicy(() => refused.promise);
  const bad = globalThis.__h.WEBRTC_OFFER({ from: 'REVOKED', payload: { type: 'offer', sdp: 'x' } });
  await tick();
  await ice('REVOKED', 1);
  refused.resolve(false);
  await bad;
  assert.equal(pcs.length, before, 'no connection for a refused offer');
  assert.equal(rtc.earlyCandidates?.has?.('REVOKED') ?? false, false, 'its buffered candidates are discarded');
});

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall early ICE checks passed');
process.exit(0);
