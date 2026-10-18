/**
 * 只處理這台該收的 topic（AegisTrans 審查 A；對應 TofuTalk 21da0cc）：真的 mqtt.ts（stub 掉 mqtt.js 與網路）。
 *   clientId 固定、clean:false、session 保留 24 小時：EMQX 會把舊版留下的全域訂閱（4c281d0 之前、正式版 cc682d7 訂的
 *   `mist/broadcast`）原樣還原給新版，而 handleMessage 不看 topic → 那個全域 topic 上偽造 `from` 的 PREKEY_REQUEST、
 *   SCREEN_SHARE_OFFER 照樣分派，還把對方標成在線（審查的 probe-broadcast-persisted）。
 *   現在：知道帳號時只處理帳號自己的命名空間（mist/acct/{uid}/…）、我的裝置群組（mist/group/aegistrans:{uid}:my-devices）、
 *   這台的 kick 通道（aegis/device/{aegis_device_id}/kicked），其他 topic 一律丟；連上時退訂舊的全域 topic。
 *   沒有帳號的 dev broker 照舊。
 *   伺服器端：AegisTrans broker 的 deny_action 不在 repo 裡，token 的 ACL 對 `mist/broadcast` 保留只能訂閱的權限
 *   （scripts/check-mqtt-acl.py），舊版訂閱不會被拒、也不會因此被斷線；誰都不能往裡面發。
 * Run: node scripts/check-mqtt-topic-scope.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'aegistrans-topics-'));
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
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/mqtt.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub] });
const store = { aegis_device_id: 'dev-1', aegistrans_device_id: 'acct-dev-1' };
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem(k, v) { store[k] = v; }, removeItem(k) { delete store[k]; } };
const kicks = [];
globalThis.window = { dispatchEvent: (e) => { kicks.push(e.type); return true; }, addEventListener() {}, removeEventListener() {} };
console.warn = () => {}; console.error = () => {};
const { mqttService: svc, MessageType } = await import(pathToFileURL(join(dir, 'm.mjs')));

const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
};
const ME = 'A'.repeat(43) + '=';
const PEER = 'B'.repeat(43) + '=';
const safe = (k) => k.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
svc.publicKeyBase64 = ME;
svc.accountUserId = 'u1';
const got = [];
for (const type of [MessageType.PREKEY_REQUEST, MessageType.SCREEN_SHARE_OFFER, MessageType.ENCRYPTED_MESSAGE]) {
  svc.onMessage(type, (m) => got.push(`${type}@${m.payload?.via ?? '?'}`));
}
const presence = [];
svc.onPresenceChange((pk, on) => presence.push(`${pk.slice(0, 4)}:${on}`));
let rosterPings = 0;
svc.onRosterChanged(() => { rosterPings++; });
const msg = (type, via, from = PEER) => Buffer.from(JSON.stringify({ type, from, payload: { via }, timestamp: Date.now() }));
const kick = () => Buffer.from(JSON.stringify({ type: 'kicked', at: Date.now() }));

await check('messages on the old global topic (persisted clean:false subscription) or another account are dropped', async () => {
  got.length = 0; presence.length = 0; kicks.length = 0;
  svc.handleMessage('mist/broadcast', msg(MessageType.PREKEY_REQUEST, 'broadcast'));
  svc.handleMessage('mist/broadcast', msg(MessageType.SCREEN_SHARE_OFFER, 'broadcast'));
  svc.handleMessage(`mist/acct/u2/user/${safe(ME)}/inbox`, msg(MessageType.PREKEY_REQUEST, 'other-account'));
  svc.handleMessage(`mist/acct/u1x/user/${safe(ME)}/inbox`, msg(MessageType.PREKEY_REQUEST, 'prefix-trick'));
  svc.handleMessage(`mist/user/${safe(ME)}/inbox`, msg(MessageType.PREKEY_REQUEST, 'pre-account-scheme'));
  svc.handleMessage('mist/group/aegistrans:u2:my-devices', msg(MessageType.ENCRYPTED_MESSAGE, 'other-group'));
  svc.handleMessage('aegis/device/dev-2/kicked', kick());   // ACL 准訂 aegis/device/+/kicked：別台的 kick 通道
  assert.deepEqual(got, [], `dispatched: ${got.join(', ')}`);
  assert.deepEqual(presence, [], `presence inferred from dropped messages: ${presence.join(', ')}`);
  assert.deepEqual(kicks, [], "another device's kick channel is not this device's");
});

await check("the account's own topics still work (inbox, account broadcast, roster, my-devices group, this device's kick channel)", async () => {
  got.length = 0; presence.length = 0; rosterPings = 0; kicks.length = 0;
  svc.handleMessage(`mist/acct/u1/user/${safe(ME)}/inbox`, msg(MessageType.PREKEY_REQUEST, 'inbox'));
  svc.handleMessage(`mist/acct/u1/broadcast`, msg(MessageType.SCREEN_SHARE_OFFER, 'account-broadcast'));
  svc.handleMessage('mist/group/aegistrans:u1:my-devices', msg(MessageType.ENCRYPTED_MESSAGE, 'my-devices'));
  svc.handleMessage(`mist/acct/u1/devices`, Buffer.from(JSON.stringify({ type: 'roster_ping', from: PEER, at: Date.now() })));
  svc.handleMessage('aegis/device/dev-1/kicked', kick());
  assert.deepEqual(got, ['prekey_request@inbox', 'screen_share_offer@account-broadcast', 'encrypted_message@my-devices']);
  assert.equal(rosterPings, 1);
  assert.deepEqual(presence, [`${PEER.slice(0, 4)}:true`]);
  assert.deepEqual(kicks, ['aegis:device-kick-signal'], "this device's kick channel still dispatches the kick signal");
});

await check('on connect the old global topic is unsubscribed (the account topics are subscribed as before)', async () => {
  const subs = []; const unsubs = [];
  svc.client = { connected: true, subscribe: (t) => subs.push(Array.isArray(t) ? t.join(',') : t), unsubscribe: (t) => unsubs.push(Array.isArray(t) ? t.join(',') : t), publish() {} };
  svc.subscribeToDefaultTopics();
  assert.ok(unsubs.some((t) => t.split(',').includes('mist/broadcast')), `unsubscribed: [${unsubs.join(' | ')}]`);
  assert.ok(subs.includes(`mist/acct/u1/user/${safe(ME)}/inbox`) && subs.includes('mist/acct/u1/broadcast'), `subscribed: [${subs.join(' | ')}]`);
  assert.ok(subs.includes('aegis/device/dev-1/kicked'), 'the kick channel is still subscribed');
  assert.ok(!subs.includes('mist/broadcast'));
  svc.stopPresenceHeartbeat?.(); svc.stopPresenceStaleSweep?.();
  svc.client = null;
});

await check('dev broker without an account id keeps the legacy topics', async () => {
  got.length = 0;
  svc.accountUserId = null;
  svc.handleMessage('mist/broadcast', msg(MessageType.SCREEN_SHARE_OFFER, 'dev-broadcast'));
  assert.deepEqual(got, ['screen_share_offer@dev-broadcast']);
  svc.accountUserId = 'u1';
});

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall topic scope checks passed');
process.exit(0);
