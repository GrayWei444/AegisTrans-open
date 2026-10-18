/**
 * 「仍是本帳號裝置」檢查在 API 慢、掛掉時不能卡住或誤判（對應 TofuTalk 06fe74a，審查 HIGH-2）：
 *   真的 services/accountDevices.ts／services/auth.ts（esbuild；指紋、金鑰 stub 掉）。
 *   accountDeviceCheck 擋著每個入站 DataChannel 幀、offer、配對與金鑰訊息。以前快取 60 秒過期後每次檢查都等一次
 *   GET /devices，而 listDevices 沒有逾時；還沒成功抓過清單時誰都不是自己的裝置 → 聊天／檔案幀不回 ACK 直接丟、
 *   offer 被拒、X3DH_INIT 與金鑰訊息被丟。
 *   現在：
 *   - 已知裝置、沒有 invalidate：直接用快取回答，超過 60 秒才在背景重抓（stale-while-revalidate）。
 *   - 不認得的裝置（每 10 秒最多重抓一次）或 invalidate 之後的 strict（配對、金鑰訊息）：等重抓，但最多約 5 秒，之後照
 *     快取回答；invalidate 之後已知裝置照快取回答、立刻在背景重抓（對應 TofuTalk afc85e8，AegisTrans 審查 C）。
 *   - invalidate 不沿用它之前就開始的重抓（generation）；晚到的舊結果不蓋掉新的。
 *   - listDevices 10 秒逾時（AbortController＋計時器：iOS 15 沒有 AbortSignal.timeout），請求結束就清掉計時器。
 *   - 上一份成功的清單（只有公鑰）存在本機（aegistrans_ 開頭、依帳號分開），冷啟動時 API 掛著也認得自己的裝置；
 *     每次抓成功就更新。
 *   - 撤銷照樣有效：invalidate 後重抓成功，被撤的裝置就被拒。
 *   - 別處抓到的成功清單（useAuth 每 20 秒，auth.onDeviceListFetched）也餵給檢查，依請求開始的時間排先後（對應 TofuTalk
 *     aaaf536，審查 LOW-4）。
 *   - 排先後、算快取年齡用單調時鐘（performance.now()，只增不減），別處的清單在開始時取 deviceListStamp()：系統時間
 *     往回調不會讓之後的清單被丟（對應 TofuTalk cf8f03d，審查 round-3 MEDIUM-2）。
 * Run: node scripts/check-account-device-check.mjs
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
const dir = mkdtempSync(join(tmpdir(), 'acctcheck-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/(fingerprint|keyEncryption|apiBase)$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path.includes('apiBase') ? 'export const apiBase = () => "https://api.test";'
    : a.path.includes('fingerprint') ? 'export async function computeMachineFingerprint(){ return "fp" }'
    : 'export async function clearEncryptionKey(){}' }));
} };
await require('esbuild').build({ stdin: { contents: `
  export { accountDeviceCheck } from './services/accountDevices.ts';
  export * as acct from './services/accountDevices.ts';
  export { listDevices, onDeviceListFetched } from './services/auth.ts';`, resolveDir: src, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'c.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const m = await import(pathToFileURL(join(dir, 'c.mjs')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = async (p) => { const t = Date.now(); const value = await p; return { value, ms: Date.now() - t }; };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const failures = [];
const check = async (name, fn) => {
  let timer;
  const hung = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('still pending after 10 s (hung on the device list)')), 10_000); });
  try { await Promise.race([fn(), hung]); console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
  finally { clearTimeout(timer); }
};

await check('known peer after the 60 s TTL with a hung GET /devices: answered from the cache at once (probe1)', async () => {
  let clock = 1_000_000; let calls = 0; let hang = false;
  const isDevice = m.accountDeviceCheck(async () => { calls++; if (hang) return new Promise(() => {}); return ['A', 'B']; }, { now: () => clock });
  assert.equal(await isDevice('A'), true);
  clock += 61_000; hang = true;
  const r = await Promise.race([timed(isDevice('A')), sleep(2000).then(() => 'pending')]);
  assert.notEqual(r, 'pending', 'check for a KNOWN peer is still pending after 2 s');
  assert.ok(r.value === true && r.ms < 100, `answered ${r.value} after ${r.ms} ms`);
  assert.equal(calls, 2, 'and a background refresh was started');
});

await check('known peer with a slow list: no wait; the background refresh updates the cache when it lands', async () => {
  let clock = 0; let next = deferred(); let calls = 0;
  const isDevice = m.accountDeviceCheck(() => { calls++; return next.promise; }, { now: () => clock, maxWaitMs: 300 });
  const first = isDevice('A');
  next.resolve(['A', 'B']);
  assert.equal(await first, true);
  clock += 61_000; next = deferred();
  const r = await timed(isDevice('B'));
  assert.ok(r.value === true && r.ms < 50, `known peer answered ${r.value} after ${r.ms} ms`);
  assert.equal(calls, 2);
  assert.equal(await isDevice('A'), true, 'only one background refresh in flight');
  assert.equal(calls, 2);
  next.resolve(['A']);                     // B 被撤銷了：背景重抓落地後就不認
  await sleep(0);
  assert.equal(await isDevice('B'), false, 'the refreshed list applies');
});

await check('unknown peer: waits for the refresh at most ~5 s, then answers from the cache; at most one refresh per 10 s', async () => {
  let calls = 0;
  const isDevice = m.accountDeviceCheck(async () => { calls++; return new Promise(() => {}); });
  const r = await timed(isDevice('X'));
  assert.equal(r.value, false);
  assert.ok(r.ms >= 4500 && r.ms < 6500, `waited ${r.ms} ms (want ~5000)`);
  const again = await timed(isDevice('Y'));
  assert.ok(again.value === false && again.ms < 100, `a second unknown peer within 10 s answered after ${again.ms} ms`);
  assert.equal(calls, 1, 'no second refresh within 10 s');
});

await check('unknown peer that the refresh lists (a newly added device) is accepted', async () => {
  let clock = 0; let listed = ['A'];
  const isDevice = m.accountDeviceCheck(async () => listed, { now: () => clock, maxWaitMs: 300 });
  assert.equal(await isDevice('A'), true);
  listed = ['A', 'NEW'];
  assert.equal(await isDevice('NEW'), false, 'within 10 s of the last fetch an unknown peer does not refetch');
  clock += 10_001;
  assert.equal(await isDevice('NEW'), true);
});

await check('invalidate() does not reuse a refresh that started before it; a late older result does not overwrite', async () => {
  const pending = [];
  const isDevice = m.accountDeviceCheck(() => { const d = deferred(); pending.push(d); return d.promise; }, { maxWaitMs: 1000 });
  const first = isDevice('B');            // R1 開始（撤銷前）
  await sleep(0);
  isDevice.invalidate();                  // B 剛被撤銷
  const after = isDevice('B');
  await sleep(0);
  assert.equal(pending.length, 2, `invalidate must start a new refresh (got ${pending.length} fetch(es))`);
  pending[1].resolve(['A']);              // R2：撤銷之後的清單
  assert.equal(await after, false, 'the check after invalidate answers from the refresh that started after it');
  pending[0].resolve(['A', 'B']);         // R1 晚到（撤銷前的清單）
  await first; await sleep(0);
  assert.equal(await isDevice('B'), false, 'the late pre-invalidate list must not bring B back');
});

await check('revoked device: refused once a refresh after invalidate succeeds; an outage only costs one bounded wait', async () => {
  let clock = 0; let listed = ['A', 'B']; let down = false; let calls = 0;
  const isDevice = m.accountDeviceCheck(async () => { calls++; if (down) throw new Error('down'); return listed; }, { now: () => clock, maxWaitMs: 300 });
  assert.equal(await isDevice('B'), true);
  listed = ['A'];
  isDevice.invalidate();
  assert.equal(await isDevice.strict('B'), false, 'revoked B refused right after invalidate + refresh (strict: pairing, key messages)');
  listed = ['A', 'C'];
  down = true;
  isDevice.invalidate();
  const first = await timed(isDevice('A'));
  assert.ok(first.value === true && first.ms < 50, `API down after invalidate: a known peer is answered from the cache at once (${first.ms} ms)`);
  const r = await timed(isDevice.strict('A'));
  assert.ok(r.value === true, 'strict: after its one bounded wait the cached list answers');
  const again = await timed(isDevice.strict('A'));
  assert.ok(again.value === true && again.ms < 50, `later strict checks do not wait again (${again.ms} ms)`);
  await sleep(0);                          // （背景重抓失敗落地）
  const callsDown = calls;
  down = false; clock += 10_001;
  assert.equal(await isDevice('A'), true);
  await sleep(0);
  assert.equal(calls, callsDown + 1, 'while the list is still unconfirmed after invalidate, a background retry runs (≤ 1 per 10 s)');
  assert.equal(await isDevice('C'), true, 'and its result applies');
});

await check('cold start while the API is down: the persisted list is trusted; every successful fetch updates it (public keys only)', async () => {
  const persist = m.acct.accountDevicePersistence;
  assert.equal(typeof persist, 'function', 'accountDevices.accountDevicePersistence(userId) does not exist');
  store.clear();
  let down = false;
  const online = m.accountDeviceCheck(async () => { if (down) throw new Error('down'); return ['ME', 'PHONE', 'MAC']; }, { ...persist('user-1'), maxWaitMs: 300 });
  assert.equal(await online('PHONE'), true);
  const keys = [...store.keys()];
  assert.ok(keys.length === 1 && keys[0].startsWith('aegistrans_'), `persisted under an aegistrans_ key (got ${keys.join(', ')})`);
  assert.deepEqual(JSON.parse(store.get(keys[0])).sort(), ['MAC', 'ME', 'PHONE'], 'only the public keys are stored');
  // 重新開 App，API 掛著
  down = true;
  const cold = m.accountDeviceCheck(() => new Promise(() => {}), { ...persist('user-1'), maxWaitMs: 300 });
  const r = await timed(cold('MAC'));
  assert.ok(r.value === true && r.ms < 50, `own device trusted from the persisted list (${r.value}, ${r.ms} ms)`);
  assert.equal(await cold('STRANGER'), false, 'others are still refused');
  const other = m.accountDeviceCheck(() => new Promise(() => {}), { ...persist('user-2'), maxWaitMs: 300 });
  assert.equal(await other('MAC'), false, 'another account on this device does not inherit the list');
  // 撤銷後的清單也會寫回去
  const later = m.accountDeviceCheck(async () => ['ME', 'PHONE'], persist('user-1'));
  assert.equal(await later('PHONE'), true, 'known from the seed (answered at once; refreshed in the background)');
  await sleep(10);
  assert.equal(await later('MAC'), false, 'the background refresh replaced the seed');
  assert.deepEqual(JSON.parse(store.get(keys[0])).sort(), ['ME', 'PHONE'], 'updated on every successful fetch');
  store.set(keys[0], '{"not":"a list"}');
  assert.equal(persist('user-1').seed, null, 'a corrupt entry is ignored');
});

await check('listDevices gives up after 10 s without AbortSignal.timeout (iOS 15) and clears its timer when done', async () => {
  const originalTimeout = AbortSignal.timeout;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const armed = []; const cleared = [];
  delete AbortSignal.timeout;              // iOS 15 WebView：沒有這個 API
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms !== 10_000) return realSetTimeout(fn, ms, ...rest);
    const t = { fn, ms }; armed.push(t); return t;
  };
  globalThis.clearTimeout = (t) => { if (armed.includes(t)) cleared.push(t); else realClearTimeout(t); };
  try {
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      if (!init?.signal) return;             // 沒帶 signal → 永遠卡住
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const p = m.listDevices('jwt');
    await sleep(0);
    assert.equal(armed.length, 1, `listDevices must arm a 10 s timeout that works without AbortSignal.timeout (armed ${armed.length})`);
    armed[0].fn();
    await assert.rejects(p, /device list unavailable/);
    armed.length = 0; cleared.length = 0;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ devices: [{ id: 'd1', pubkey: 'P1' }] }) });
    assert.deepEqual(await m.listDevices('jwt'), [{ id: 'd1', pubkey: 'P1' }]);
    assert.ok(armed.length === 1 && cleared.length === 1 && cleared[0] === armed[0], 'the timer is cleared once the list has been read');
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
    await assert.rejects(m.listDevices('jwt'), /device list unavailable/, 'an unreadable body is an unavailable list too');
  } finally {
    AbortSignal.timeout = originalTimeout;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

// 審查 LOW-4（對應 TofuTalk aaaf536；af4aecc）：快取只靠自己（60 秒過期才在背景重抓）→ 答案最多舊 60 秒以上；useAuth 每 20 秒
// 本來就抓一次清單，那些成功的清單也餵給檢查（不多打 API）。依「開始抓」的時間套用：撤銷前就開始、撤銷後才回來的清單不能
// 讓被撤的裝置回來。
await check('LOW-4 lists fetched elsewhere (auth.onDeviceListFetched) update the cache without an extra fetch', async () => {
  let clock = 1_000; let calls = 0; let listed = ['A', 'B'];
  const isDevice = m.accountDeviceCheck(async () => { calls++; return listed; }, { now: () => clock, maxWaitMs: 300 });
  assert.equal(await isDevice('B'), true);
  assert.equal(typeof isDevice.observe, 'function', 'the check has no observe(keys, startedAt)');
  clock += 20_000; listed = ['A', 'NEW'];                  // B 被撤銷、NEW 剛加入
  isDevice.observe(['A', 'NEW'], clock - 50);              // useAuth 的週期刷新抓到了
  assert.equal(await isDevice('NEW'), true, 'a newly added device is accepted without waiting');
  assert.equal(calls, 1, 'and without a fetch of its own');
  assert.equal(await isDevice('B'), false, 'a revoked device is no longer answered from the 20 s old cache');
  const fetches = calls;
  clock += 50_000;
  isDevice.observe(['A', 'NEW'], clock - 50);
  clock += 50_000;                                          // 自己的清單已經 100 秒沒抓，但別處的清單 50 秒前才到
  assert.equal(await isDevice('A'), true);
  await sleep(0);
  assert.equal(calls, fetches, `no background fetch while outside lists keep the cache fresh (${calls - fetches} extra)`);
  isDevice.observe([], clock);
  assert.equal(await isDevice('A'), true, 'an empty list means "not fetched" and changes nothing');
});

await check('LOW-4 an outside list that started before the newest applied list (or before invalidate) cannot bring a revoked device back', async () => {
  let clock = 1_000; let listed = ['A', 'B']; let calls = 0;
  const isDevice = m.accountDeviceCheck(async () => { calls++; return listed; }, { now: () => clock, maxWaitMs: 300 });
  assert.equal(await isDevice('B'), true);
  const slowStartedAt = clock;                            // useAuth 的請求在撤銷前就開始了
  clock += 100; listed = ['A'];
  isDevice.invalidate();                                  // B 被撤銷（roster ping）
  assert.equal(await isDevice.strict('B'), false);
  isDevice.observe(['A', 'B'], slowStartedAt);           // 撤銷前開始的那個請求現在才回來
  assert.equal(await isDevice('B'), false, 'the older list does not overwrite the newer one');
  const fetches = calls;
  clock += 100;
  isDevice.invalidate();
  isDevice.observe(['A', 'B'], clock - 50);               // 一樣是 invalidate 之前開始的
  assert.equal(await isDevice.strict('B'), false, 'a list that started before invalidate does not confirm it');
  assert.equal(calls, fetches + 1, 'so the check still fetches its own list after invalidate');
  clock += 100;
  isDevice.invalidate();
  isDevice.observe(['A', 'C'], clock + 10);               // invalidate 之後才開始的請求：算確認
  assert.equal(await isDevice('C'), true);
  assert.equal(calls, fetches + 1, 'a list that started after invalidate confirms it: no extra fetch');
});

await check('LOW-4 listDevices tells listeners when the request started; App.tsx feeds the check from every fetched list', async () => {
  const seen = [];
  const stop = m.onDeviceListFetched((devices, meta) => seen.push({ n: devices.length, startedAt: meta?.startedAt }));
  // 開始時間是檢查的單調時鐘（deviceListStamp；還沒設檢查時就是 performance.now()），不是系統時間（round-3 MEDIUM-2）
  const before = performance.now();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ devices: [{ id: 'd1', pubkey: 'A' }] }) });
  try { await m.listDevices('jwt'); } finally { stop(); globalThis.fetch = realFetch; }
  assert.equal(seen.length, 1);
  assert.ok(typeof seen[0].startedAt === 'number' && seen[0].startedAt >= before && seen[0].startedAt <= performance.now(), `startedAt ${seen[0].startedAt}`);
  const app = readFileSync(join(src, 'App.tsx'), 'utf8');
  const feed = app.slice(app.indexOf('useEffect(() => onDeviceListFetched('), app.indexOf('}), []);', app.indexOf('useEffect(() => onDeviceListFetched(')));
  assert.ok(/observeFetchedDeviceList\(pubkeys, startedAt\)/.test(feed), 'App.tsx: onDeviceListFetched → observeFetchedDeviceList(pubkeys, startedAt)');
});

// AegisTrans 審查 C（對應 TofuTalk afc85e8）：每次 roster ping（每台裝置每次連上 MQTT 都發，含每小時換 token 的重連）都
// invalidate，之後連已知裝置也要等 GET /devices：handleOffer 先等它才建 peer → 對方 100 ms 後送來的 ICE 因為「不認得的 peer」
// 被丟；peerSync 每個入站幀也卡住。現在 invalidate 之後已知裝置照快取回答、背景重抓（重抓落地後 pruneToAccountPeers 斷開
// 被撤的）；只有配對與金鑰訊息（strict）要等確認。
await check('C: after invalidate a known peer is answered from the cache at once; the refresh lands in the background', async () => {
  let clock = 0; let next = deferred(); let calls = 0;
  const isDevice = m.accountDeviceCheck(() => { calls++; return next.promise; }, { now: () => clock, maxWaitMs: 1000 });
  const first = isDevice('A'); next.resolve(['A', 'B']); assert.equal(await first, true);
  next = deferred();
  isDevice.invalidate();                                   // roster ping（B 剛被撤銷，或只是別台重連）
  const r = await timed(isDevice('B'));
  assert.ok(r.value === true && r.ms < 50, `known peer after invalidate answered ${r.value} after ${r.ms} ms`);
  assert.equal(calls, 2, 'and a refresh started right away');
  assert.equal(await isDevice('A'), true);
  assert.equal(calls, 2, 'one refresh per invalidate');
  next.resolve(['A']);
  await sleep(0);
  assert.equal(await isDevice('B'), false, 'once the refresh lands the revoked peer is refused');
});

await check('C: strict() (pairing, key messages) still waits for the refresh after invalidate; unknown peers still wait', async () => {
  let next = deferred(); let calls = 0;
  const isDevice = m.accountDeviceCheck(() => { calls++; return next.promise; }, { maxWaitMs: 300 });
  const first = isDevice('A'); next.resolve(['A', 'B']); assert.equal(await first, true);
  assert.equal(typeof isDevice.strict, 'function', 'the check has no strict()');
  next = deferred();
  isDevice.invalidate();
  const pending = isDevice.strict('B');
  await sleep(10);
  next.resolve(['A']);
  assert.equal(await pending, false, 'a revoked device cannot re-pair or hand over a key from the cache');
  assert.equal(await isDevice.strict('A'), true);
  assert.equal(calls, 2);
  next = deferred();
  isDevice.invalidate();
  const unknown = await timed(isDevice('NEW'));             // 不認得的：等一次限時重抓（清單掛著）
  assert.ok(unknown.value === false && unknown.ms >= 250, `unknown peer waited ${unknown.ms} ms`);
  m.acct.setAccountDeviceCheck(isDevice);
  assert.equal(typeof m.acct.isConfirmedAccountDevice, 'function', 'accountDevices has no isConfirmedAccountDevice');
  next.resolve(['A', 'NEW']); await sleep(0);
  assert.equal(await m.acct.isConfirmedAccountDevice('NEW'), true);
  m.acct.setAccountDeviceCheck(null);
});

// 審查 round-3 MEDIUM-2（對應 TofuTalk cf8f03d）：清單依「開始抓」的 Date.now() 排先後、快取依 Date.now() 算多久以前。
// 系統時間往回調（NTP 校正、手動改時間）之後每份新清單都比已套用的「舊」→ 一直被丟：被撤的裝置照樣通過 strict、新裝置
// 一直被拒，直到時間追上；年齡算成負的，快取也不再過期。
await check('round-3 MEDIUM-2 the system clock stepping back an hour does not freeze the check (its default clock is monotonic)', async () => {
  const realNow = Date.now;
  let list = ['A', 'X'];
  const isDevice = m.accountDeviceCheck(async () => list, { maxWaitMs: 300 });
  try {
    assert.equal(await isDevice('X'), true);
    Date.now = () => realNow() - 3_600_000;                  // 系統時間往回調一小時
    list = ['A', 'NEW'];                                     // X 被撤銷、NEW 剛加入
    isDevice.invalidate();                                   // roster ping
    assert.equal(await isDevice.strict('X'), false, 'the revoked device still passes strict() after the clock stepped back');
    assert.equal(await isDevice('NEW'), true, 'the new device is refused after the clock stepped back');
  } finally { Date.now = realNow; }
});

await check('round-3 MEDIUM-2 an injected clock that steps back: own refreshes still apply in start order and the cache still ages', async () => {
  let clock = 1_000_000; let list = ['A', 'X']; let calls = 0;
  const isDevice = m.accountDeviceCheck(async () => { calls++; return list; }, { now: () => clock, maxWaitMs: 300 });
  assert.equal(await isDevice('X'), true);
  clock -= 3_600_000;
  list = ['A', 'NEW'];
  isDevice.invalidate();
  assert.equal(await isDevice.strict('X'), false, 'the revoked device still passes strict()');
  assert.equal(await isDevice('NEW'), true, 'the new device is refused');
  const fetches = calls;
  clock += 61_000;
  assert.equal(await isDevice('A'), true);
  await sleep(0);
  assert.equal(calls, fetches + 1, 'a minute later the cache is not refreshed (its age went negative)');
});

await check('round-3 MEDIUM-2 lists fetched elsewhere are stamped on the check\'s clock (deviceListStamp), so they keep their order too', async () => {
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  let server = ['A', 'X'];                                   // 伺服器上的帳號裝置（檢查自己的重抓與 useAuth 的刷新都看到它）
  const isDevice = m.accountDeviceCheck(async () => server, { maxWaitMs: 300 });
  m.acct.setAccountDeviceCheck(isDevice);
  // App.tsx：onDeviceListFetched → observeFetchedDeviceList(pubkeys, startedAt)
  const stop = m.onDeviceListFetched((devices, meta) => m.acct.observeFetchedDeviceList(devices.map((d) => d.pubkey), meta.startedAt));
  let delay = 0;
  globalThis.fetch = async () => {
    const [listed, wait] = [server, delay];
    await sleep(wait);
    return { ok: true, status: 200, json: async () => ({ devices: listed.map((pubkey, i) => ({ id: 'd' + i, pubkey })) }) };
  };
  try {
    await m.listDevices('jwt');                              // useAuth 的週期刷新
    Date.now = () => realNow() - 600_000;                    // 系統時間往回調十分鐘
    delay = 50;
    const before = m.listDevices('jwt');                     // 撤銷前就開始的週期刷新，撤銷之後才回來
    delay = 0;
    await sleep(0);
    server = ['A', 'NEW'];                                   // X 被撤銷、NEW 加入
    isDevice.invalidate();                                   // roster ping
    await m.listDevices('jwt');                              // 撤銷之後才開始的週期刷新
    await before;
    assert.equal(await isDevice.strict('X'), false, 'the revoked device passes strict() after the observed post-revoke list');
    assert.equal(await isDevice('NEW'), true, 'the new device from the observed list is refused');
  } finally { stop(); Date.now = realNow; globalThis.fetch = realFetch; m.acct.setAccountDeviceCheck(null); }
});

await check('App.tsx seeds the check from the persisted list', async () => {
  const app = readFileSync(join(src, 'App.tsx'), 'utf8');
  assert.ok(/setAccountDeviceCheck\(accountDeviceCheck\([\s\S]{0,600}accountDevicePersistence\(/.test(app), 'App.tsx passes accountDevicePersistence(userId)');
});

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall account device check checks passed');
process.exit(0);
