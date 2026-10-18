/**
 * 本機資料擁有者綁伺服器（hooks/useAuth.ts 的 aegistrans_owner_server）：真的 useAuth ＋ 真的 serverChoice
 * （esbuild；React、指紋、金鑰、本機資料清除 stub 掉，清除只記錄有沒有被呼叫）。
 *   - 同一台伺服器、同一個 user.id 再登入 → 不清本機資料。
 *   - 舊安裝沒有 owner_server（只有 owner_id）、用預設伺服器 → 視為同一台，不清（升級不會誤刪）。
 *   - 換到另一台伺服器後登入，即使 user.id 字串相同 → 當成換帳號，先清本機資料。
 *   - 登入成功後 owner_server 寫成目前伺服器。
 * Run: node scripts/check-server-owner-scope.mjs
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
const dir = mkdtempSync(join(tmpdir(), 'ownerscope-'));
const OWNER_ID = 'aegistrans_owner_id';
const OWNER_SERVER = 'aegistrans_owner_server';
const SERVER = 'aegistrans_server';

const fakeReact = `
export function useState(init) {
  const h = globalThis.__hook; const slot = h.slots++;
  const value = slot in h.values ? h.values[slot] : (typeof init === 'function' ? init() : init);
  return [value, (v) => h.sets.push([slot, v])];
}
export function useEffect() {}
export function useCallback(fn) { return fn; }`;
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^react$|^\.\/(fingerprint|keyEncryption|apiBase)$|services\/(accountWipe|keyEncryption)$/ },
    (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === 'react' ? fakeReact
    : a.path.includes('apiBase') ? 'export const apiBase = () => "https://api.test";'
    : a.path.includes('fingerprint') ? 'export async function computeMachineFingerprint(){ return "fp" }'
    : a.path.includes('accountWipe') ? 'export async function wipeLocalAccountData(){ globalThis.__wiped++ } export async function hasLocalAccountData(){ return "has" }'
    : `export async function clearEncryptionKey(){} export async function deriveEncryptionKey(){ return {} }
       export function setEncryptionKey(){} export async function rekeyProtectedRecords(){}` }));
} };

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window = { location: { search: '', reload() {} }, history: { replaceState() {} } };
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/password/login')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, token: 'h.eyJleHAiOjQxMDI0NDQ4MDB9.s', user: { id: 'u1', email: 'a@b.test' } }) };
  }
  throw new Error(`unexpected request ${url}`);
};

let n = 0;
/** 每次都重新 bundle → serverChoice 的快取從零開始（就像換伺服器後重新載入） */
async function login(before) {
  store.clear();
  for (const [k, v] of Object.entries(before)) store.set(k, v);
  const out = join(dir, `h${n++}.mjs`);
  await require('esbuild').build({ entryPoints: [src('hooks/useAuth.ts')], bundle: true, platform: 'node', format: 'esm',
    outfile: out, logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
  const { useAuth } = await import(pathToFileURL(out));
  globalThis.__wiped = 0;
  globalThis.__hook = { slots: 0, sets: [], effects: [], values: {} };
  const ok = await useAuth().loginWithPassword('a@b.test', 'password123');
  return { ok, wiped: globalThis.__wiped };
}

const custom = JSON.stringify({ v: 1, apiUrl: 'https://a.example', mqttUrl: 'wss://m.example/mqtt' });
const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log('ok  ', name); } catch (e) { failures.push(name); console.log('FAIL', name, '\n     ', e.message); }
};

await check('同伺服器、同帳號再登入：不清本機資料，owner_server 記成 default', async () => {
  const r = await login({ [OWNER_ID]: 'u1', [OWNER_SERVER]: 'default' });
  assert.equal(r.ok, true);
  assert.equal(r.wiped, 0);
  assert.equal(store.get(OWNER_SERVER), 'default');
});

await check('舊安裝（只有 owner_id）用預設伺服器登入：視為同一台，不清', async () => {
  const r = await login({ [OWNER_ID]: 'u1' });
  assert.equal(r.ok, true);
  assert.equal(r.wiped, 0);
  assert.equal(store.get(OWNER_SERVER), 'default');
});

await check('換到自架伺服器後登入（user.id 字串相同）：先清本機資料，owner_server 改記新伺服器', async () => {
  const r = await login({ [OWNER_ID]: 'u1', [OWNER_SERVER]: 'default', [SERVER]: custom });
  assert.equal(r.ok, true);
  assert.equal(r.wiped, 1);
  assert.equal(store.get(OWNER_SERVER), 'custom:https://a.example');
});

await check('從自架伺服器換回預設後登入：同樣先清', async () => {
  const r = await login({ [OWNER_ID]: 'u1', [OWNER_SERVER]: 'custom:https://a.example' });
  assert.equal(r.wiped, 1);
  assert.equal(store.get(OWNER_SERVER), 'default');
});

await check('同一台自架伺服器再登入：不清', async () => {
  const r = await login({ [OWNER_ID]: 'u1', [OWNER_SERVER]: 'custom:https://a.example', [SERVER]: custom });
  assert.equal(r.wiped, 0);
});

if (failures.length) {
  console.error(`\n${failures.length} 項失敗`);
  process.exit(1);
}
console.log('\n全部通過');
