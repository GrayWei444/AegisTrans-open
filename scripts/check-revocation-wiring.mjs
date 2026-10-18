/**
 * 撤銷裝置的接線檢查（稽核 B1、B10、B11，對應 TofuTalk ad0c17b）：App.tsx 把「仍是本帳號裝置」接到每個入口，
 * mqtt.ts 能公告名冊變動。
 *   行為由 check-revocation-pairing／-group-key／-transport 測；這裡確認入口真的接上了，因為 App.tsx 需要瀏覽器與
 *   React 才跑得動。announceRosterChange 用真的 mqtt.ts（stub 掉 mqtt.js 與網路）測。
 * Run: node scripts/check-revocation-wiring.mjs   （APP_SRC=<path> 可指定別份 App.tsx 做對照）
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => join(root, 'packages/pwa/src', p);
const app = readFileSync(process.env.APP_SRC ?? src('App.tsx'), 'utf8');

const register = app.indexOf('setAccountDeviceCheck(accountDeviceCheck(');
const pairing = app.indexOf('registerCryptoFunctions({');
assert.ok(register > 0 && register < pairing, 'the account check is registered before the pairing handlers');
assert.ok(/onRosterChanged\(\(\) => invalidateAccountDevices\(\)\)/.test(app), 'a roster ping refetches the device list');

const enc = app.slice(app.indexOf('const processMessage = async'), app.indexOf("if (data.type === 'group_key_request')"));
// AegisTrans 審查 C（對應 TofuTalk afc85e8）：金鑰訊息與配對在 invalidate（roster ping）之後要等確認（strict）；其他入口照快取回答
const strictAt = enc.indexOf('isConfirmedAccountDevice(senderPk)');
assert.ok(strictAt >= 0 && strictAt < enc.indexOf('crypto.decrypt('),
  'MQTT key messages are dropped from non-account devices (confirmed after a roster ping) before decrypting');
assert.ok(/groupId !== myDevicesGroupId\(userId\)/.test(enc) && enc.search(/groupId !== myDevicesGroupId\(userId\)/) < enc.indexOf('handleKeyDistribution('),
  'only my-devices group keys are accepted');

const revoke = app.slice(app.indexOf('const handler = async (e: Event)'), app.indexOf("window.addEventListener('aegistrans:deviceRevoked'"));
assert.ok(/listDevices\(jwt\)/.test(revoke), 'the revoke rotation goes to the devices the server lists now');
assert.ok(/announceRosterChange\(\)/.test(revoke) && /pruneToAccountPeers\(/.test(revoke), 'revoke tells other devices to refetch and prunes locally');
assert.ok(/pruneToAccountPeers\(\[\.\.\.peerPubkeys, myPubkey\]\)/.test(app), 'every device-list update prunes peers that are gone');
assert.ok(/clearOutboxForPeer\(detail\.revokedPubkey\)/.test(revoke), 'the device this client revoked loses its outbox at once');
assert.ok(/onDeviceListFetched\(\(devices[^)]*\) =>[\s\S]{0,300}observeAccountDeviceList\(/.test(app),
  'every successful device list feeds the outbox clean-up (24 h of continuous absence)');
console.log('PASS App.tsx wires the account check into pairing, key messages, revoke, pruning and outbox clean-up');

const pairingSrc = readFileSync(src('services/devicePairing.ts'), 'utf8');
assert.equal((pairingSrc.match(/await isConfirmedAccountDevice\(/g) ?? []).length, 3, 'all three pairing handlers wait for a confirmed account device');
assert.ok(!/await isAccountDevice\(/.test(pairingSrc), 'no pairing handler uses the cached-only check');
const peerSyncSrc = readFileSync(src('services/peerSync.ts'), 'utf8');
assert.ok(/setInboundPolicy\(isAccountDevice\)/.test(peerSyncSrc) && /prev\.then\(\(\) => isAccountDevice\(peerPubkey\)\)/.test(peerSyncSrc),
  'offers and inbound data frames use the cached check (no GET /devices wait after a roster ping)');
console.log('PASS pairing and key messages wait for confirmation; offers and data frames answer from the cache');

// ── mqtt.ts：announceRosterChange 真的發名冊 ping ──
const require = createRequire(join(root, 'packages/pwa/package.json'));
const dir = mkdtempSync(join(tmpdir(), 'revwire-'));
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
await require('esbuild').build({ entryPoints: [src('services/mqtt.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
console.warn = () => {}; console.error = () => {};
const { mqttService: svc } = await import(pathToFileURL(join(dir, 'm.mjs')));
const published = [];
svc.publicKeyBase64 = 'A'.repeat(43) + '=';
svc.accountUserId = 'u1';
svc.client = { connected: true, publish: (topic, body) => published.push({ topic, body: JSON.parse(body) }) };
assert.equal(typeof svc.announceRosterChange, 'function', 'mqttService.announceRosterChange exists');
svc.announceRosterChange();
assert.deepEqual(published.map((p) => [p.topic, p.body.type]), [['mist/acct/u1/devices', 'roster_ping']],
  'announceRosterChange pings the account roster topic');
console.log('PASS announceRosterChange publishes a roster ping to the account');
