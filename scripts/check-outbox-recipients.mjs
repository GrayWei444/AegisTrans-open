/**
 * outbox 的收件者清單不讀訊息內容（AegisTrans 審查 E；對應 TofuTalk 0b266b8）：真的 p2pSend.ts＋database.ts，
 *   @capacitor-community/sqlite 換成 sql.js（記下每個 SQL）。
 *   outboxRecipients() 在每次成功抓到裝置清單時（useAuth 每 20 秒、帳號檢查、撤銷流程）都跑；以前讀出整個 outbox
 *   （含每則加密內容，可能是大量訊息／大段內容）再在 JS 去重。現在 SELECT DISTINCT recipient_pubkey。
 * Run: node scripts/check-outbox-recipients.mjs
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
const SQL = await require('sql.js/dist/sql-asm.js')();
const dir = mkdtempSync(join(tmpdir(), 'outboxrcpt-'));
const fakeSqlite = `
const db = () => globalThis.__sqlite;
const log = (s) => globalThis.__sql.push(s);
const select = (statement, values) => { const st = db().prepare(statement); st.bind(values ?? []); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; };
export const CapacitorSQLite = {
  isSecretStored: async () => ({ result: true }), setEncryptionSecret: async () => {},
  createConnection: async () => {}, open: async () => {}, close: async () => {}, closeConnection: async () => {},
  initWebStore: async () => {}, saveToStore: async () => {}, getDatabaseList: async () => ({ values: [] }),
  execute: async ({ statements }) => { log(statements); db().exec(statements); return { changes: { changes: db().getRowsModified() } }; },
  run: async ({ statement, values }) => { log(statement); db().run(statement, values ?? []); return { changes: { changes: db().getRowsModified() } }; },
  query: async ({ statement, values }) => { log(statement); return { values: select(statement, values) }; },
};`;
const stubs = {
  '@capacitor-community/sqlite': fakeSqlite,
  '@capacitor-community/sqlite/dist/esm/web': 'export class CapacitorSQLiteWeb {}',
  '@capacitor/core': "export const Capacitor = { getPlatform: () => 'android' };",
  './capacitor': 'export const isNativeApp = () => true;',
  '../utils/devLog': 'export const devLog = () => {}; export const devWarn = () => {};',
  '../utils/diagLog': 'export const diagLog = () => {};',
};
const stubPlugin = { name: 'stub', setup(b) {
  b.onResolve({ filter: /.*/ }, (a) => (a.path in stubs ? { path: a.path, namespace: 's' } : null));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents: stubs[a.path] }));
} };
await require('esbuild').build({ stdin: { contents: `
  export * as p2p from './services/p2pSend.ts';
  export * as db from './services/database.ts';`, resolveDir: src, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'o.mjs'), logLevel: 'silent', plugins: [stubPlugin],
  define: { 'import.meta.env': '{}' } });
globalThis.__sqlite = new SQL.Database();
globalThis.__sql = [];
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { p2p, db } = await import(pathToFileURL(join(dir, 'o.mjs')));
await db.initDatabase();
const big = 'x'.repeat(10_000);
for (let i = 0; i < 6; i++) {
  globalThis.__sqlite.run(`INSERT INTO pending_messages (id, recipient_pubkey, encrypted_payload, message_type, created_at) VALUES (?, ?, ?, 'text', ?)`,
    [`m${i}`, i % 2 ? 'PEER_A' : 'PEER_B', big, Date.now()]);
}

globalThis.__sql = [];
const recipients = await p2p.outboxRecipients();
assert.deepEqual([...recipients].sort(), ['PEER_A', 'PEER_B']);
const statements = globalThis.__sql.join('\n');
assert.ok(!/encrypted_payload|original_content/.test(statements), `reads message contents to list recipients:\n${statements}`);
assert.ok(/SELECT DISTINCT recipient_pubkey FROM pending_messages/i.test(statements), `uses SELECT DISTINCT:\n${statements}`);
console.log('PASS outboxRecipients lists recipients with SELECT DISTINCT, without reading message contents');
