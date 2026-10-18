/**
 * 換帳號時也清掉「上一份成功的裝置清單」（af4aecc 存在 localStorage 的
 * aegistrans_account_device_keys:<userId>）：真的 accountWipe.ts，stub 掉 DB／金鑰／blob。
 *   那份清單含上一個帳號所有裝置的公鑰，和同樣含公鑰、本來就會清的 aegistrans_x3dh_accepted_v1 一樣屬於帳號資料。
 * Run: node scripts/check-account-wipe-device-seed.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'wipeseed-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/(database|keyEncryption|messageStore|nativeFileStream)$|utils\/debugFlags$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path.includes('database') ? 'export async function initDatabase(){} export async function clearTable(){} export async function deleteSetting(){}'
    : a.path.includes('keyEncryption') ? 'export async function clearEncryptionKey(){}'
    : a.path.includes('messageStore') ? 'export async function clearAllBlobs(){} export async function hasAnyBlob(){ return false }'
    : a.path.includes('nativeFileStream') ? 'export function getNativeFileStream(){ return null }'
    : 'export const DEBUG_TOOLS = false;' }));
} };
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/accountWipe.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'w.mjs'), logLevel: 'silent', plugins: [stub] });

const store = new Map([
  ['aegistrans_account_device_keys:user-a', '["PK1","PK2"]'],
  ['aegistrans_account_device_keys:user-b', '["PK3"]'],
  ['aegistrans_theme', 'dark'],
  ['aegis_device_id', 'install-1'],
]);
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.sessionStorage = { removeItem() {} };
const { wipeLocalAccountData } = await import(pathToFileURL(join(dir, 'w.mjs')));
await wipeLocalAccountData();

assert.deepEqual([...store.keys()].filter((k) => k.startsWith('aegistrans_account_device_keys:')), [],
  'every remembered device list is removed on an account switch');
assert.equal(store.get('aegistrans_theme'), 'dark', 'UI preferences are kept');
assert.equal(store.get('aegis_device_id'), 'install-1', 'the install id is kept');
console.log('PASS switching accounts also forgets the previous account\'s remembered device list');
