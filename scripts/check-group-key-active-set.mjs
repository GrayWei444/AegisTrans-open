/**
 * 群組金鑰的 active 集合由資料推導，不看到貨順序（對應 TofuTalk 8e3b49d，審查 LOW on dd13829；稽核 B11）：
 *   真的 groupKey.ts／myDevicesGroup.ts／database.ts（esbuild；@capacitor-community/sqlite 換成 sql.js，
 *   跑真的建表與 migration）。AegisTrans 沒有 device agent，TofuTalk 測試裡 agent 的部分不移植。
 *   以前輪換（isRotation:true）一到就停用其他所有 key：先到 R2、晚到的舊輪換 R1 變成唯一的 active key（倒回舊 key）。
 *   只改成「只停用比較舊的」又會重開 B11：快被撤銷的裝置先塞一把未來時間的 key，撤銷後的輪換蓋不掉它。
 *   現在：每把 key 記下是不是輪換、由哪台裝置交來（自己生的＝自己）；
 *   - 錨點＝createdAt 最新、交來的裝置仍在帳號上（或自己）的輪換 key；錨點＋比錨點新、仍在帳號上的裝置交來的
 *     一般 key 才 active，其他都不是；
 *   - 交來的裝置不在帳號上了，它交來的 key 一律不算（裝置清單一更新，被撤裝置塞的 key 就失效）；
 *   - 欄位加上之前的舊資料列沒有交來的裝置：照舊（維持原本的 active，出現錨點後停用）；
 *   - 每把 key 到貨、每次裝置清單更新都重算；舊資料庫補欄位（schema v6）。
 *   對應 TofuTalk 8310e24（審查 MEDIUM-1）：一般 key 要在錨點之後還算 active，除了 createdAt 比錨點新，還要在錨點之後
 *   才存進本機（stored_seq，本機計數）；輪換 key 的 createdAt＝max(現在, 本機最新 key＋1)；schema v7。
 *   對應 TofuTalk cccba3b（審查 round-3 MEDIUM-1）：輪換只繼承日期在「現在＋5 分鐘」以內的 key，最多到「現在＋5 分鐘＋1」；
 *   日期超過上限的資料列先拉回上限。
 *   對應 TofuTalk 00af54d（審查 LOW-1）：回應 group_key_request 的補發帶 decryptOnly，收方只拿來解密、永遠不算 active；
 *   之後以一般分發／輪換收到同一把才照常算；schema v8。
 *   對應 TofuTalk 8c6a0b5（審查 LOW-6）：沒有 active key 時生 key 也在寫入佇列裡（ensureActiveGroupKey），不被同時進行的重算
 *   寫成不 active。
 * Run: node scripts/check-group-key-active-set.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname;
const src = root + 'packages/pwa/src/';
const require = createRequire(root + 'packages/pwa/package.json');
const esbuild = require('esbuild');
const SQL = await require('sql.js/dist/sql-asm.js')();
const dir = mkdtempSync(join(tmpdir(), 'gkactive-'));

// @capacitor-community/sqlite → sql.js（globalThis.__sqlite），database.ts 的建表／migration／查詢照原樣跑
const fakeSqlite = `
const db = () => globalThis.__sqlite;
const select = (statement, values) => { const st = db().prepare(statement); st.bind(values ?? []); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; };
// globalThis.__lat：每次呼叫的延遲（毫秒），模擬手機上 Capacitor SQLite 的原生橋接（每個呼叫都是一個 macrotask）
const lag = () => (globalThis.__lat ? new Promise((r) => setTimeout(r, globalThis.__lat)) : undefined);
export const CapacitorSQLite = {
  isSecretStored: async () => ({ result: true }), setEncryptionSecret: async () => {},
  createConnection: async () => {}, open: async () => {}, close: async () => {}, closeConnection: async () => {},
  initWebStore: async () => {}, saveToStore: async () => {}, getDatabaseList: async () => ({ values: [] }),
  execute: async ({ statements }) => { await lag(); db().exec(statements); return { changes: { changes: db().getRowsModified() } }; },
  run: async ({ statement, values }) => { await lag(); db().run(statement, values ?? []); return { changes: { changes: db().getRowsModified() } }; },
  query: async ({ statement, values }) => { await lag(); return { values: select(statement, values) }; },
};`;
const stubs = {
  '@capacitor-community/sqlite': fakeSqlite,
  '@capacitor-community/sqlite/dist/esm/web': 'export class CapacitorSQLiteWeb {}',
  '@capacitor/core': "export const Capacitor = { getPlatform: () => 'android' };",
  './capacitor': 'export const isNativeApp = () => true;',
  './mqtt': `export const MessageType = { ENCRYPTED_MESSAGE: 'encrypted_message' };
    export const mqttService = { sendToUser: (to, type, payload) => globalThis.__sent.push({ to, payload }) };`,
  '../utils/devLog': 'export const devLog = () => {}; export const devWarn = () => {};',
};
const stubPlugin = { name: 'stub', setup(b) {
  b.onResolve({ filter: /.*/ }, (a) => (a.path in stubs ? { path: a.path, namespace: 's' } : null));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents: stubs[a.path] }));
} };
await esbuild.build({ stdin: { contents: `
  export * as gk from './services/groupKey.ts';
  export * as devices from './services/myDevicesGroup.ts';
  export * as db from './services/database.ts';`, resolveDir: src, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'k.mjs'), logLevel: 'silent', plugins: [stubPlugin],
  define: { 'import.meta.env': '{}' } });

const local = new Map([['aegistrans_identity_pub_b64', 'ME']]);   // 這台的公鑰（identity.ts 的快取）
globalThis.localStorage = { getItem: (k) => local.get(k) ?? null, setItem: (k, v) => local.set(k, String(v)), removeItem: (k) => local.delete(k) };
console.warn = () => {};

let instance = 0;
/** 新的一次執行（新的模組實例）；不給 DB 就是全新安裝 */
async function boot(sqlite = new SQL.Database()) {
  globalThis.__sqlite = sqlite;
  globalThis.__sent = [];
  return import(pathToFileURL(join(dir, 'k.mjs')).href + '?run=' + (++instance));
}
const G = 'aegistrans:u1:my-devices';
const DAY = 86_400_000;
const dist = (keyId, createdAt, isRotation) => ({ type: 'group_key_distribution', groupId: G, keyId,
  keyBase64: Buffer.from(keyId).toString('base64'), createdAt, createdBy: 'X', isRotation });
const select = (sql) => (globalThis.__sqlite.exec(sql)[0]?.values ?? []);
const activeSet = () => select('SELECT key_id FROM group_keys WHERE is_active = 1 ORDER BY key_id').map((r) => r[0]);
const sending = async (gk) => (await gk.getActiveGroupKey(G))?.keyId;
/** 帳號裝置清單更新（App.tsx：auth.onDeviceListFetched）；舊版沒有這個入口 */
const listed = async (gk, keys) => { await gk.observeAccountDevices?.(keys); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
};

await check('a late, older rotation does not roll the active key back', async () => {
  const { gk } = await boot();
  await listed(gk, ['ME', 'A', 'C']);
  const t = Date.now();
  await gk.handleKeyDistribution(dist('R2', t, true), 'C');
  await gk.handleKeyDistribution(dist('R1', t - 60_000, true), 'A');      // 較早的輪換晚到（broker 排隊、離線補送）
  assert.equal(await sending(gk), 'R2', `R1 arriving after R2 must not become the active key (active: ${activeSet()})`);
  assert.deepEqual(activeSet(), ['R2']);
  await gk.handleKeyDistribution(dist('R1', t - 60_000, true), 'A');
  assert.deepEqual(activeSet(), ['R2'], 'a re-delivered older rotation changes nothing');
  await gk.handleKeyDistribution(dist('OLD', t - 120_000, false), 'C');
  assert.deepEqual(activeSet(), ['R2'], 'an ordinary key older than the newest rotation is not active');
  await gk.handleKeyDistribution(dist('K', t + 1000, false), 'A');         // 之後才生的一般 key（例如新裝置配對）
  assert.deepEqual(activeSet(), ['K', 'R2'], 'an ordinary key newer than the rotation from an account device stays usable');
  assert.equal(await sending(gk), 'K', 'senders still pick the newest active key');
});

await check('a future-dated key planted by a device that is then revoked is not active once the device list drops it', async () => {
  const { gk } = await boot();
  await listed(gk, ['ME', 'A', 'M']);
  const t = Date.now();
  await gk.handleKeyDistribution(dist('K_A', t - 10_000, false), 'A');
  await gk.handleKeyDistribution(dist('K_M', t + 365 * DAY, false), 'M');  // 時間被夾到「現在＋5 分鐘」
  await gk.handleKeyDistribution(dist('R_M', t + 365 * DAY, true), 'M');   // 也塞一把「輪換」
  await gk.handleKeyDistribution(dist('R', t + 1000, true), 'A');          // A 撤銷 M 後的輪換
  await listed(gk, ['ME', 'A']);                                           // 清單更新：M 不在了
  assert.deepEqual(activeSet(), ['R'], `only the revocation rotation is active, nothing from M (active: ${activeSet()})`);
  assert.equal(await sending(gk), 'R');
  assert.ok(await gk.getGroupKeyById('K_M'), "M's keys stay stored (older messages still decrypt), just not active");
  await gk.handleKeyDistribution(dist('K_M', t + 365 * DAY, false), 'A');  // 有人回應 key request 把它再送來
  assert.deepEqual(activeSet(), ['R'], 're-delivering M\'s key does not bring it back while M is off the account');
  await gk.handleKeyDistribution(dist('K_A2', t + 2000, false), 'A');
  assert.deepEqual(activeSet(), ['K_A2', 'R'], 'a later arrival is computed against the current list');
});

await check('the list update can come first (roster ping), then the rotation: same result', async () => {
  const { gk } = await boot();
  await listed(gk, ['ME', 'A', 'M']);
  const t = Date.now();
  await gk.handleKeyDistribution(dist('K_M', t + 365 * DAY, false), 'M');
  await listed(gk, ['ME', 'A']);
  await gk.handleKeyDistribution(dist('R', t + 1000, true), 'A');
  assert.deepEqual(activeSet(), ['R']);
});

await check('a device missing from one list and back in the next: its keys count again (derived, nothing lost)', async () => {
  const { gk } = await boot();
  await listed(gk, ['ME', 'A', 'B']);
  const t = Date.now();
  await gk.handleKeyDistribution(dist('R', t - 5000, true), 'A');
  await gk.handleKeyDistribution(dist('K_B', t, false), 'B');
  assert.deepEqual(activeSet(), ['K_B', 'R']);
  await listed(gk, ['ME', 'A']);
  assert.deepEqual(activeSet(), ['R'], 'B gone → its key is not active');
  await listed(gk, ['ME', 'A', 'B']);
  assert.deepEqual(activeSet(), ['K_B', 'R'], 'B back → its key is active again');
  await listed(gk, []);
  assert.deepEqual(activeSet(), ['K_B', 'R'], 'an empty list means "not fetched" and changes nothing');
});

await check('the revoking device: after its rotation only the new key is active, nothing from the revoked device', async () => {
  const { gk, devices } = await boot();
  await listed(gk, ['ME', 'B', 'M']);
  const own = await devices.ensureMyDevicesGroupKey('u1', 'ME');
  const t = Date.now();
  await gk.handleKeyDistribution(dist('K_M', t + 365 * DAY, false), 'M');
  await gk.handleKeyDistribution(dist('R_M', t + 365 * DAY, true), 'M');
  // App.tsx 撤銷流程：伺服器的剩餘清單（或 React 的清單減掉被撤的那台）→ 輪換 → 發給剩下的裝置
  await listed(gk, ['ME', 'B']);
  await devices.rotateGroupKeyAndDispatch('u1', 'ME', ['B'], async (_peer, text) => ({ toJson: () => text }));
  await sleep(10);
  const sent = JSON.parse(globalThis.__sent.at(-1).payload);
  assert.equal(sent.isRotation, true, 'dispatched as a rotation');
  assert.notEqual(sent.keyId, own.keyId);
  assert.deepEqual(activeSet(), [sent.keyId], `only the new key is active (active: ${activeSet()})`);
  assert.equal(await sending(gk), sent.keyId);
  const [row] = select(`SELECT is_rotation, distributor FROM group_keys WHERE key_id = '${sent.keyId}'`);
  assert.deepEqual(row, [1, 'ME'], 'stored as a rotation distributed by this device');
  const [mine] = select(`SELECT is_rotation, distributor FROM group_keys WHERE key_id = '${own.keyId}'`);
  assert.deepEqual(mine, [0, 'ME'], 'own generated keys are recorded as distributed by this device');
});

await check('restart before any device list: stored state stands; a dropped device\'s key does not come back', async () => {
  const sqlite = new SQL.Database();
  let { gk } = await boot(sqlite);
  await listed(gk, ['ME', 'A', 'M']);
  const t = Date.now();
  await gk.handleKeyDistribution(dist('K_M', t + 365 * DAY, false), 'M');
  await gk.handleKeyDistribution(dist('R', t + 1000, true), 'A');
  await listed(gk, ['ME', 'A']);
  assert.deepEqual(activeSet(), ['R']);
  ({ gk } = await boot(sqlite));                                            // App 重開，清單還沒抓到
  await gk.handleKeyDistribution(dist('K_A2', t + 2000, false), 'A');
  assert.deepEqual(activeSet(), ['K_A2', 'R'], 'a key from a device that just passed the account check is active');
  await gk.handleKeyDistribution(dist('R_old', t - 60_000, true), 'A');
  assert.deepEqual(activeSet(), ['K_A2', 'R'], 'a late older rotation still does not roll back');
  await listed(gk, ['ME', 'A']);
  assert.deepEqual(activeSet(), ['K_A2', 'R']);
});

// 審查 MEDIUM-1（對應 TofuTalk 8310e24）：一般 key 只要 createdAt 比輪換新就算 active → 時鐘快的裝置（+5 分鐘夾值內，或自己快
// 1 小時）的 key 勝過撤銷後的輪換，被撤的裝置手上正好有那把 key。
await check('MEDIUM-1 revoker: right after revoking it sends with the rotation, even holding a legit key dated ahead of its clock', async () => {
  const { gk, devices } = await boot();
  await listed(gk, ['ME', 'B', 'X']);
  const t = Date.now();
  await gk.handleKeyDistribution(dist('K_B', t + 4 * 60_000, false), 'B');   // B 的時鐘快 4 分鐘；X 撤銷前也拿到了 K_B
  await listed(gk, ['ME', 'B']);
  await devices.rotateGroupKeyAndDispatch('u1', 'ME', ['B'], async (_p, text) => ({ toJson: () => text }));
  await sleep(10);
  const sent = JSON.parse(globalThis.__sent.at(-1).payload);
  assert.equal(await sending(gk), sent.keyId, `sends with ${await sending(gk)} (active: ${activeSet()})`);
  assert.ok(sent.createdAt > t + 4 * 60_000, 'the rotation is dated after every key this device knows');
});

await check('MEDIUM-1 fast-clock device: its own key dated an hour ahead does not outlive the rotation it receives', async () => {
  const { gk, devices } = await boot();
  await listed(gk, ['ME', 'A', 'X']);
  const realNow = Date.now;
  Date.now = () => realNow() + 60 * 60_000;
  const own = await devices.ensureMyDevicesGroupKey('u1', 'ME');
  Date.now = realNow;
  await listed(gk, ['ME', 'A']);
  await gk.handleKeyDistribution(dist('R', realNow() + 1000, true), 'A');
  assert.equal(await sending(gk), 'R', `sends with ${await sending(gk)} (own=${own.keyId}); active: ${activeSet()}`);
  await gk.handleKeyDistribution(dist('K_NEW', realNow() + 2000, false), 'A');
  assert.equal(await sending(gk), 'K_NEW', 'a key created after the rotation (arrives after it, newer) is still used');
});

await check('MEDIUM-1 third device: rotation first, then a pre-rotation key dated ahead (known to the rotator) → still the rotation', async () => {
  const A = await boot();
  await listed(A.gk, ['ME', 'B', 'X']);
  const t = Date.now();
  await A.gk.handleKeyDistribution(dist('K_B', t + 4 * 60_000, false), 'B');
  await listed(A.gk, ['ME', 'B', 'D']);
  await A.devices.rotateGroupKeyAndDispatch('u1', 'ME', ['B', 'D'], async (_p, text) => ({ toJson: () => text }));
  await sleep(10);
  const rotation = JSON.parse(globalThis.__sent.at(-1).payload);
  const D = await boot();                                                    // 另一台：先收到輪換，B 撤銷前排隊的 K_B 晚到
  await listed(D.gk, ['ME', 'A', 'B']);
  await D.gk.handleKeyDistribution(rotation, 'A');
  await D.gk.handleKeyDistribution(dist('K_B', t + 4 * 60_000, false), 'B');
  assert.equal(await sending(D.gk), rotation.keyId, `sends with ${await sending(D.gk)}; active: ${activeSet()}`);
});

// 審查 round-3 MEDIUM-1（對應 TofuTalk cccba3b）：輪換的 createdAt＝max(現在, 本機最新 key＋1)，沒有上限。已部署的舊版存的
// 資料列沒有夾值（時鐘快的裝置可能給一年後的日期）→ 輪換繼承一年後的日期；之後別台撤銷再輪換，在這台永遠比較舊，
// 這台繼續用自己那把輪換 key——後來被撤的裝置手上正好有它。
const legacyRow = (keyId, createdAt) => globalThis.__sqlite.run(
  'INSERT INTO group_keys (group_id, key_id, key_base64, created_at, created_by, is_active, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  [G, keyId, Buffer.from(keyId).toString('base64'), createdAt, 'Z', 0, createdAt + 30 * DAY]);
/** 兩台裝置輪流跑（各自的模組實例）：切到那台的資料庫與公鑰 */
const device = async (pk) => { const sqlite = new SQL.Database(); return { pk, sqlite, ...(await boot(sqlite)) }; };
const on = async (dev, fn) => {
  globalThis.__sqlite = dev.sqlite;
  local.set('aegistrans_identity_pub_b64', dev.pk);
  try { return await fn(dev.gk); } finally { local.set('aegistrans_identity_pub_b64', 'ME'); }
};

await check('round-3 MEDIUM-1 a far-future legacy row is not inherited: the next device\'s rotation takes over here', async () => {
  const t = Date.now();
  const me = await device('ME');
  const a = await device('A');
  const R1 = await on(me, async (gk) => {
    await listed(gk, ['ME', 'A', 'Y']);
    legacyRow('K_LEGACY', t + 365 * DAY);                                    // 舊版存的、沒夾值的資料列
    return (await gk.rotateGroupKey(G, 'ME')).newKey;                         // 這台撤銷 X；Y 拿到 R1
  });
  const R2 = await on(a, async (gk) => {                                     // A 收到 R1，之後撤銷 Y、輪換
    await listed(gk, ['ME', 'A', 'Y']);
    await gk.handleKeyDistribution(gk.createKeyDistribution(R1, true), 'ME');
    await listed(gk, ['ME', 'A']);
    return (await gk.rotateGroupKey(G, 'A')).newKey;
  });
  await on(me, async (gk) => {
    await listed(gk, ['ME', 'A']);
    await gk.handleKeyDistribution(gk.createKeyDistribution(R2, true), 'A');
    assert.equal(await sending(gk), R2.keyId, `sends with ${await sending(gk) === R1.keyId ? 'R1 (Y holds it)' : await sending(gk)}`);
  });
  assert.ok(R1.createdAt <= t + 5 * 60_000 + 1000, `R1 dated ${((R1.createdAt - t) / DAY).toFixed(3)} days ahead`);
  const lone = await device('ME');                                           // A 還沒收到 R1 就輪換（一秒後）
  await on(lone, async (gk) => {
    await listed(gk, ['ME', 'A', 'Y']);
    legacyRow('K_LEGACY', t + 365 * DAY);
    const { newKey } = await gk.rotateGroupKey(G, 'ME');
    await listed(gk, ['ME', 'A']);
    await gk.handleKeyDistribution(dist('R_A', Date.now() + 1000, true), 'A');
    assert.equal(await sending(gk), 'R_A', `sends with ${await sending(gk) === newKey.keyId ? 'its own rotation (Y holds it)' : await sending(gk)}`);
  });
});

await check('round-3 MEDIUM-1 a rotation this device made while its clock ran an hour fast does not outrank its next rotation', async () => {
  const { gk } = await boot();
  await listed(gk, ['ME', 'A', 'X']);
  const realNow = Date.now;
  Date.now = () => realNow() + 60 * 60_000;
  const { newKey: fast } = await gk.rotateGroupKey(G, 'ME');                   // 時鐘快一小時時輪換（X 也拿到了）
  Date.now = realNow;                                                         // 時鐘校正
  await listed(gk, ['ME', 'A']);
  const { newKey: R } = await gk.rotateGroupKey(G, 'ME');                     // 撤銷 X
  assert.equal(await sending(gk), R.keyId, `sends with ${await sending(gk) === fast.keyId ? 'the fast-dated rotation (X holds it)' : await sending(gk)}`);
  assert.ok(R.createdAt <= Date.now() + 5 * 60_000 + 1, `the new rotation is dated ${Math.round((R.createdAt - Date.now()) / 60_000)} min ahead`);
  const [[stored]] = select(`SELECT created_at FROM group_keys WHERE key_id = '${fast.keyId}'`);
  assert.ok(stored < R.createdAt, 'the fast-dated rotation is pulled back below the new one');
});

// 審查 LOW-1（對應 TofuTalk 00af54d；34dd0c7 之前就有）：回應 group_key_request 補發的 key 可以是任何存著的 key——包括被撤的
// 裝置撤銷前塞給 B 的未來時間 key。新配對的 C 收到後把它當成一般 key → active，被撤的裝置的 key 經由合法的 B 洗白。
const answerFrom = async (responder, keyId, requester) => {
  globalThis.__sent = [];
  assert.equal(await responder.devices.dispatchGroupKeyByIdTo('u1', keyId, requester, async (_p, text) => ({ toJson: () => text })), true);
  return JSON.parse(globalThis.__sent.at(-1).payload);
};

await check('LOW-1 a key handed over in answer to our key request decrypts, but never becomes active (no laundering via B)', async () => {
  const t = Date.now();
  const B = await boot();
  await listed(B.gk, ['ME', 'A', 'X']);
  await B.gk.handleKeyDistribution(dist('K_X', t + 4 * 60_000, false), 'X');   // X 撤銷前塞給 B
  await listed(B.gk, ['ME', 'A']);
  await B.gk.handleKeyDistribution(dist('R', t - 60_000, true), 'A');          // A 撤銷 X 後的輪換
  assert.equal(await sending(B.gk), 'R');
  const answer = await answerFrom(B, 'K_X', 'C');                             // C 解不開某則訊息、向 B 要 K_X
  const C = await boot();                                                     // C：X 撤銷後才配對的新裝置
  await listed(C.gk, ['ME', 'A', 'B']);
  await C.gk.handleKeyDistribution(dist('R', t - 60_000, true), 'A');
  await C.gk.handleKeyDistribution(answer, 'B');
  assert.equal(await sending(C.gk), 'R', `sends with ${await sending(C.gk)}; active: ${activeSet()}`);
  assert.equal((await C.gk.getGroupKeyById('K_X'))?.keyBase64, Buffer.from('K_X').toString('base64'), 'the answered key is stored for decryption');
  assert.deepEqual(activeSet(), ['R']);
  await listed(C.gk, ['ME', 'A']);
  await listed(C.gk, ['ME', 'A', 'B']);
  assert.deepEqual(activeSet(), ['R'], 'no device list update makes it active either');
});

await check('LOW-1 an answered key with no rotation around is still not active; a later ordinary distribution of it counts as usual', async () => {
  const B = await boot();
  await listed(B.gk, ['ME', 'C']);
  const own = await B.devices.ensureMyDevicesGroupKey('u1', 'ME');
  const answer = await answerFrom(B, own.keyId, 'C');
  assert.equal(answer.decryptOnly, true, 'the answer is marked as decrypt-only on the wire');
  const C = await boot();
  await listed(C.gk, ['ME', 'B']);
  await C.gk.handleKeyDistribution(answer, 'B');                              // 回應先到（配對時的分發還在路上）
  assert.deepEqual(activeSet(), []);
  const { decryptOnly: _answerFlag, ...ordinary } = answer;                   // B 配對時送的 active key（dispatchGroupKeyTo）晚到
  await C.gk.handleKeyDistribution(ordinary, 'B');
  assert.equal(await sending(C.gk), own.keyId, 'the ordinary distribution makes it usable');
});

/** 上一版（schema v6）建的資料庫：有 is_rotation／distributor，沒有 stored_seq；rows 依序插入 */
function v6Database(rows) {
  const sqlite = new SQL.Database();
  sqlite.run(`CREATE TABLE sync_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  sqlite.run(`INSERT INTO sync_metadata (key, value) VALUES ('schema_version', '6')`);
  sqlite.run(`CREATE TABLE group_keys (group_id TEXT NOT NULL, key_id TEXT NOT NULL PRIMARY KEY, key_base64 TEXT NOT NULL,
    created_at INTEGER NOT NULL, created_by TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, expires_at INTEGER NOT NULL,
    is_rotation INTEGER NOT NULL DEFAULT 0, distributor TEXT)`);
  for (const [keyId, createdAt, active, rotation, distributor] of rows) {
    sqlite.run('INSERT INTO group_keys VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [G, keyId, Buffer.from(keyId).toString('base64'), createdAt, 'X', active, createdAt + 30 * DAY, rotation, distributor]);
  }
  return sqlite;
}

await check('MEDIUM-1 migration: a v6 database gets stored_seq in insertion order; keys stored before the rotation stop outliving it', async () => {
  const t = Date.now();
  // K_FAST 在輪換之前就存了（時鐘快）；K_AFTER 在輪換之後才到
  const { gk, db } = await boot(v6Database([['K_FAST', t + 4 * 60_000, 1, 0, 'B'], ['R', t, 1, 1, 'A'], ['K_AFTER', t + 1000, 1, 0, 'A']]));
  await db.initDatabase();
  const columns = select('PRAGMA table_info(group_keys)').map((c) => c[1]);
  assert.ok(columns.includes('stored_seq') && columns.includes('decrypt_only'), `group_keys columns after migration: ${columns.join(', ')}`);
  assert.deepEqual(select("SELECT value FROM sync_metadata WHERE key = 'schema_version'"), [['8']]);
  assert.deepEqual(select('SELECT key_id FROM group_keys ORDER BY stored_seq').map((r) => r[0]), ['K_FAST', 'R', 'K_AFTER']);
  await listed(gk, ['ME', 'A', 'B']);
  assert.deepEqual(activeSet(), ['K_AFTER', 'R'], `active after migration: ${activeSet()}`);
  await gk.handleKeyDistribution(dist('K2', t + 2000, false), 'A');
  assert.equal(select("SELECT stored_seq FROM group_keys WHERE key_id = 'K2'")[0][0], 4, 'new keys continue the sequence');
});

/** 上一版（schema v5，cc682d7 正式版）建的資料庫：group_keys 沒有新欄位 */
function v5Database(rows) {
  const sqlite = new SQL.Database();
  sqlite.run(`CREATE TABLE sync_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  sqlite.run(`INSERT INTO sync_metadata (key, value) VALUES ('schema_version', '5')`);
  sqlite.run(`CREATE TABLE group_keys (group_id TEXT NOT NULL, key_id TEXT NOT NULL PRIMARY KEY, key_base64 TEXT NOT NULL,
    created_at INTEGER NOT NULL, created_by TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, expires_at INTEGER NOT NULL)`);
  for (const [keyId, createdAt, active] of rows) {
    sqlite.run('INSERT INTO group_keys VALUES (?, ?, ?, ?, ?, ?, ?)', [G, keyId, Buffer.from(keyId).toString('base64'), createdAt, 'X', active, createdAt + 30 * DAY]);
  }
  return sqlite;
}

await check('migration: an existing (v5) database gets the columns; its rows become legacy rows', async () => {
  const t = Date.now();
  const { db } = await boot(v5Database([['L1', t - 2000, 1]]));
  await db.initDatabase();
  const columns = select('PRAGMA table_info(group_keys)').map((c) => c[1]);
  assert.ok(columns.includes('is_rotation') && columns.includes('distributor'), `group_keys columns after migration: ${columns.join(', ')}`);
  assert.deepEqual(select("SELECT key_id, is_active, is_rotation, distributor FROM group_keys"), [['L1', 1, 0, null]], 'existing rows kept, marked legacy');
  assert.deepEqual(select("SELECT value FROM sync_metadata WHERE key = 'schema_version'"), [['8']]);
  const fresh = await boot();
  await fresh.db.initDatabase();
  const freshColumns = select('PRAGMA table_info(group_keys)').map((c) => c[1]);
  assert.ok(['is_rotation', 'distributor', 'stored_seq', 'decrypt_only'].every((c) => freshColumns.includes(c)),
    'a fresh install has the columns too');
});

await check('legacy rows (no distributor) behave as before', async () => {
  const t = Date.now();
  const { gk } = await boot(v5Database([['L_OLD', t - 3000, 0], ['L1', t - 2000, 1], ['L2', t - 1000, 1]]));
  await listed(gk, ['ME', 'A']);
  assert.deepEqual(activeSet(), ['L1', 'L2'], 'a device list does not touch legacy rows');
  assert.equal(await sending(gk), 'L2');
  await gk.handleKeyDistribution(dist('K', t, false), 'A');
  assert.deepEqual(activeSet(), ['K', 'L1', 'L2'], 'an ordinary key is added next to them (as before)');
  await gk.handleKeyDistribution(dist('L_OLD', t - 3000, false), 'A');
  assert.deepEqual(activeSet(), ['K', 'L1', 'L2'], 're-delivering a deactivated legacy key does not re-activate it');
  await gk.handleKeyDistribution(dist('R', t + 1000, true), 'A');
  assert.deepEqual(activeSet(), ['R'], 'a rotation deactivates legacy rows (as before)');
  await gk.handleKeyDistribution(dist('L1', t - 2000, false), 'A');
  assert.deepEqual(activeSet(), ['R'], 'and they stay deactivated');
});

await check('wiring: App.tsx passes the sender and feeds every device list (needs a browser / broker to run)', async () => {
  const app = readFileSync(src + 'App.tsx', 'utf8');
  assert.ok(/handleKeyDistribution\([^;]{0,120}, senderPk\)/.test(app), 'App.tsx records who sent the key');
  assert.ok(/onDeviceListFetched\(\(devices[^)]*\) =>[\s\S]{0,400}groupKeyService\.observeAccountDevices\(pubkeys\)/.test(app),
    'App.tsx: every successful device list recomputes the active keys');
  const revoke = app.slice(app.indexOf('const handler = async (e: Event)'), app.indexOf("window.addEventListener('aegistrans:deviceRevoked'"));
  assert.ok(/observeAccountDevices\(\[\.\.\.peers, myPk\]\)[\s\S]*rotateGroupKeyAndDispatch\(/.test(revoke),
    'App.tsx revoke: the remaining devices are applied before the rotation');
});

// 審查 LOW-6（對應 TofuTalk 8c6a0b5）：ensureMyDevicesGroupKey 在寫入佇列外面生 key、存 key。手機上每個 SQLite 呼叫都是原生
// 橋接（有延遲）：重算「讀全部 → 寫回」中間插進新 key 的 INSERT → 寫回時把新 key 設成 is_active = 0，回傳的 key 不是這台送訊息
// 用的 key。
await check('LOW-6 a key generated while a recompute runs (DB calls with bridge latency) stays active and is the one sent with', async () => {
  const bad = [];
  for (const [lat, gap, order] of [[1, 0, 'ensure-first'], [3, 0, 'ensure-first'], [5, 0, 'list-first'], [5, 1, 'ensure-first']]) {
    const { gk, devices } = await boot();
    await listed(gk, ['ME', 'A']);
    await gk.handleKeyDistribution(dist('K_A', Date.now() - 1000, false), 'A');
    await listed(gk, ['ME']);                                // A 不在清單上 → 沒有 active key
    globalThis.__lat = lat;
    let ensure, list;
    if (order === 'ensure-first') { ensure = devices.ensureMyDevicesGroupKey('u1', 'ME'); await sleep(gap); list = listed(gk, ['ME', 'A']); }
    else { list = listed(gk, ['ME', 'A']); await sleep(gap); ensure = devices.ensureMyDevicesGroupKey('u1', 'ME'); }
    const [, fresh] = await Promise.all([list, ensure]);
    globalThis.__lat = 0;
    const row = select(`SELECT is_active FROM group_keys WHERE key_id = '${fresh.keyId}'`);
    const used = await sending(gk);
    if (row[0]?.[0] !== 1 || used !== fresh.keyId) bad.push(`lat=${lat} gap=${gap} ${order}: is_active=${row[0]?.[0]}, sends with ${used}`);
    globalThis.__sqlite.close();
  }
  assert.deepEqual(bad, [], bad.join('; '));
});

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall group key active-set checks passed');
