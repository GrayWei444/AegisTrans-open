/**
 * 撤銷後的金鑰輪換要真的生效（稽核 B11、B1，對應 TofuTalk ce9bb6e）：真的 groupKey.ts／myDevicesGroup.ts，
 * 底下是 sql.js ＋ database.ts 的 group_keys schema。
 *   - 輪換送出時 isRotation:false → 收端不停用舊金鑰，靠 createdAt 挑 active；時鐘快的裝置的舊 key 會一直勝出。
 *   - createdAt 由送方自填：寫一個遠未來時間就能把自己的 key 釘成 active。
 *   - INSERT OR REPLACE 依 keyId：同一個 keyId 可以被換成別的位元組，被輪換掉的舊 key 也會被重新啟用。
 *   現在：輪換帶 isRotation:true，成為 active 集合的錨點（比它舊的停用；被撤裝置交來的 key 在清單更新後不算，
 *   見 check-group-key-active-set.mjs）；createdAt 最多信到「現在＋5 分鐘」；已存在的 keyId 不覆蓋。
 * Run: node scripts/check-revocation-group-key.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'packages/pwa/src');
const require = createRequire(join(root, 'packages/pwa/package.json'));
const SQL = await require('sql.js/dist/sql-asm.js')();
const sqlite = new SQL.Database();
const schema = readFileSync(join(src, 'services/database.ts'), 'utf8');
const a = schema.indexOf('CREATE TABLE IF NOT EXISTS group_keys (', schema.indexOf('const SCHEMA_SQL'));
sqlite.run(schema.slice(a, schema.indexOf(');', a) + 2));
globalThis.__sqlite = sqlite;
globalThis.__sent = [];
const dir = mkdtempSync(join(tmpdir(), 'revkey-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/database$|^\.\/mqtt$|utils\/devLog$/ }, (x) => ({ path: x.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (x) => ({ loader: 'js', contents:
    x.path === './database' ? `export async function run(sql, p = []) { globalThis.__sqlite.run(sql, p); }
      export async function query(sql, p = []) { const st = globalThis.__sqlite.prepare(sql); st.bind(p); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; }`
    : x.path === './mqtt' ? `export const MessageType = { ENCRYPTED_MESSAGE: 'encrypted_message' };
      export const mqttService = { sendToUser: (to, t, p) => globalThis.__sent.push({ to, p }) };`
    : 'export const devLog=()=>{};export const devWarn=()=>{};' }));
} };
await require('esbuild').build({ stdin: { contents: `
  export * as gk from './services/groupKey.ts';
  export { rotateGroupKeyAndDispatch } from './services/myDevicesGroup.ts';`, resolveDir: src, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'k.mjs'), logLevel: 'silent', plugins: [stub],
  define: { 'import.meta.env': '{}' } });
console.warn = () => {};
const { gk, rotateGroupKeyAndDispatch } = await import(pathToFileURL(join(dir, 'k.mjs')));
const G = 'aegistrans:u1:my-devices';
const dist = (keyId, keyBase64, createdAt, isRotation = false) =>
  ({ type: 'group_key_distribution', groupId: G, keyId, keyBase64, createdAt, createdBy: 'X', isRotation });
const active = async () => (await gk.getActiveGroupKey(G))?.keyId;
const bytes = (id) => sqlite.exec(`SELECT key_base64 FROM group_keys WHERE key_id='${id}'`)[0]?.values[0][0];

await gk.observeAccountDevices(['X', 'M']);
await gk.handleKeyDistribution(dist('old', 'AAAA', Date.now() - 1000), 'X');
await gk.handleKeyDistribution(dist('pinned', 'BBBB', Date.now() + 10 * 365 * 86400_000), 'M');   // M 快被撤銷
assert.ok((sqlite.exec("SELECT created_at FROM group_keys WHERE key_id='pinned'")[0].values[0][0]) <= Date.now() + 5 * 60_000 + 1000,
  'a far-future createdAt is clamped, so a key cannot be pinned as active forever');
await gk.handleKeyDistribution(dist('old', 'EVIL', Date.now()), 'X');
assert.equal(bytes('old'), 'AAAA', 'an existing keyId is never overwritten with different bytes');

await gk.handleKeyDistribution(dist('rot', 'CCCC', Date.now(), true), 'X');
await gk.observeAccountDevices(['X']);   // 撤銷 M 之後的裝置清單
assert.equal(await active(), 'rot', 'a rotation (with M off the account) makes the new key the only active one');
await gk.handleKeyDistribution(dist('old', 'AAAA', Date.now() - 1000), 'X');
assert.equal(await active(), 'rot', 're-delivering an old key (e.g. a key request answer) does not re-activate it');
await gk.handleKeyDistribution(dist('rot', 'CCCC', Date.now(), true), 'X');
assert.equal(await active(), 'rot', 'a re-delivered rotation keeps exactly that key active');
console.log('PASS key distribution: rotation sticks, createdAt clamped, keyIds not overwritten');

await rotateGroupKeyAndDispatch('u1', 'ME', ['P1'], async (peer, text) => ({ toJson: () => text }));
await new Promise((r) => setTimeout(r, 10));
const sentDist = JSON.parse(globalThis.__sent[0].p);
assert.equal(sentDist.isRotation, true, 'the revoke-time rotation is sent as a rotation');
console.log('PASS revoke-time rotation is dispatched with isRotation:true');
