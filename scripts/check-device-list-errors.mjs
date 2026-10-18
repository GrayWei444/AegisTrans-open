/**
 * 抓裝置清單失敗不能被當成「帳號沒有裝置」（傳輸統一，對應 TofuTalk 356970d；audit B11 相關）：
 * 真的 auth.ts listDevices（esbuild，stub 掉指紋／金鑰）＋ 呼叫端接線檢查。
 *   以前 listDevices 任何錯誤（5xx、斷網）都回 []：20 秒週期刷新與 refreshDevices 把畫面的裝置清單清空，
 *   group_key_request 的授權檢查、開機主動連線也拿到空清單。現在失敗就丟錯，呼叫端各自決定：
 *   保留上一份、拒絕（金鑰請求，寧可不給）、或這輪略過。
 * Run: node scripts/check-device-list-errors.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => join(root, 'packages/pwa/src', p);
const require = createRequire(join(root, 'packages/pwa/package.json'));
const dir = mkdtempSync(join(tmpdir(), 'devlist-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/(fingerprint|keyEncryption|apiBase)$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path.includes('apiBase') ? 'export const apiBase = () => "https://api.test";'
    : a.path.includes('fingerprint') ? 'export async function computeMachineFingerprint(){ return "fp" }'
    : 'export async function clearEncryptionKey(){}' }));
} };
await require('esbuild').build({ entryPoints: [src('services/auth.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'a.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const auth = await import(pathToFileURL(join(dir, 'a.mjs')));
const { listDevices } = auth;
// 每次抓成功都通知（outbox 清理看「連續兩次成功的清單」，對應 TofuTalk a08cc93）；失敗不通知
assert.equal(typeof auth.onDeviceListFetched, 'function', 'auth.onDeviceListFetched does not exist');
const seen = [];
const off = auth.onDeviceListFetched((list) => seen.push(list.map((d) => d.id).join(',')));

globalThis.fetch = async () => ({ ok: true, json: async () => ({ devices: [{ id: 'd1', pubkey: 'P1' }] }) });
assert.deepEqual(await listDevices('jwt'), [{ id: 'd1', pubkey: 'P1' }], 'success returns the list');
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
await assert.rejects(listDevices('jwt'), /device list unavailable/, 'a server error is an error, not an empty account');
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
await assert.rejects(listDevices('jwt'), /device list unavailable/, 'a network error too');
assert.deepEqual(seen, ['d1'], 'listeners hear every successful list and nothing else');
off();
console.log('PASS listDevices reports failures instead of returning []; successful lists are announced');

const app = readFileSync(process.env.APP_SRC ?? src('App.tsx'), 'utf8');
const useAuth = readFileSync(process.env.USE_AUTH_SRC ?? src('hooks/useAuth.ts'), 'utf8');
const refresh = useAuth.slice(useAuth.indexOf('const refreshDevices = useCallback'), useAuth.indexOf('const revokeDevice = useCallback'));
assert.ok(/catch/.test(refresh), 'refreshDevices keeps the previous list when the fetch fails');
const keyReqAt = app.indexOf("if (data.type === 'group_key_request')");
const keyReq = app.slice(keyReqAt, app.indexOf('dispatchGroupKeyByIdTo', keyReqAt));
assert.ok(/listDevices\(jwt\)\.catch\(/.test(keyReq), 'a failed lookup denies the group key request (fail closed) without throwing');
const bootConnect = app.slice(app.indexOf('// 6) 直接從後端拉最新 device 列表'), app.indexOf('void connectToPeers(peerPubkeys);'));
assert.ok(/listDevices\(auth\.jwt!\)\.catch\(/.test(bootConnect), 'a failed lookup at boot skips this round instead of aborting the boot');
console.log('PASS callers keep the old list / deny the key request / skip the boot round on failure');
