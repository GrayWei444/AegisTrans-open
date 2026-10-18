/**
 * 執行期選伺服器（services/serverChoice.ts、services/apiBase.ts）：真的程式碼（esbuild），Capacitor 與網路 stub 掉。
 *   - 預設＝官方伺服器（config/official-server.json）；網頁版用同源 /api，原生／Electron 用完整網址。
 *   - 網址檢查：只收 https／wss，localhost 可用 http／ws；不收帳密、查詢字串。
 *   - 向伺服器要設定（/aegistrans/auth/server-config）：mqtt_url 必須是 wss（localhost 可 ws），格式不對就拒絕。
 *   - 自選伺服器存在 localStorage；壞掉的紀錄會被忽略、退回預設。
 * Run: node scripts/check-server-choice.mjs
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
const dir = mkdtempSync(join(tmpdir(), 'serverchoice-'));
const official = JSON.parse(readFileSync(src('config/official-server.json'), 'utf8'));

const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^@capacitor\/core$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, () => ({ loader: 'js', contents:
    'export const Capacitor = { isNativePlatform: () => globalThis.__platform === "android", getPlatform: () => globalThis.__platform };' }));
} };
let n = 0;
const load = async (entry) => {
  const out = join(dir, `m${n++}.mjs`);
  await require('esbuild').build({ entryPoints: [src(entry)], bundle: true, platform: 'node', format: 'esm',
    outfile: out, logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
  return import(pathToFileURL(out));
};

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };

const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log('ok  ', name); } catch (e) { failures.push(name); console.log('FAIL', name, '\n     ', e.message); }
};

await check('預設＝官方伺服器；網頁版同源 /api，Android 與 Electron 用完整網址', async () => {
  store.clear();
  const m = await load('services/apiBase.ts');
  globalThis.__platform = 'web';
  assert.equal(m.apiBase(), official.webApiPath);
  globalThis.__platform = 'android';
  assert.equal(m.apiBase(), official.apiUrl);
  globalThis.__platform = 'electron';
  assert.equal(m.apiBase(), official.apiUrl);
});

await check('網址檢查：https／wss 才收，localhost 例外；帳密與查詢字串拒絕', async () => {
  const { normalizeServerUrl: v } = await load('services/serverChoice.ts');
  assert.deepEqual(v(' https://a.example/api/ ', 'api'), { ok: true, url: 'https://a.example/api' });
  assert.deepEqual(v('http://a.example', 'api'), { ok: false, reason: 'insecure' });
  assert.deepEqual(v('http://localhost:8000', 'api'), { ok: true, url: 'http://localhost:8000' });
  assert.deepEqual(v('http://127.0.0.1:8000/', 'api'), { ok: true, url: 'http://127.0.0.1:8000' });
  assert.deepEqual(v('ftp://a.example', 'api'), { ok: false, reason: 'invalid' });
  assert.deepEqual(v('https://u:p@a.example', 'api'), { ok: false, reason: 'credentials' });
  assert.deepEqual(v('https://a.example/?x=1', 'api'), { ok: false, reason: 'query' });
  assert.deepEqual(v('not a url', 'api'), { ok: false, reason: 'invalid' });
  assert.deepEqual(v('wss://m.example/mqtt', 'mqtt'), { ok: true, url: 'wss://m.example/mqtt' });
  assert.deepEqual(v('ws://m.example/mqtt', 'mqtt'), { ok: false, reason: 'insecure' });
  assert.deepEqual(v('ws://localhost:8083/mqtt', 'mqtt'), { ok: true, url: 'ws://localhost:8083/mqtt' });
  assert.deepEqual(v('https://m.example/mqtt', 'mqtt'), { ok: false, reason: 'invalid' });
});

const fakeFetch = (status, body, seen) => async (url, init) => {
  seen?.push([url, init]);
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

await check('向伺服器要設定：成功時帶回 MQTT／STUN／網頁網址，不合格的欄位丟掉', async () => {
  const { discoverServer } = await load('services/serverChoice.ts');
  const seen = [];
  const r = await discoverServer('https://a.example/', fakeFetch(200, {
    service: 'aegistrans', mqtt_url: 'wss://m.example/mqtt', turn_url: 'turn:a.example:3478',
    stun_urls: ['stun:a.example:3478', 'http://bad'], web_url: 'https://web.example', name: 'Mine',
    links: { privacy: 'https://web.example/privacy', terms: 'http://insecure.example/terms' },
  }, seen));
  assert.equal(seen[0][0], 'https://a.example/aegistrans/auth/server-config');
  assert.equal(seen[0][1].credentials, 'omit');
  assert.equal(r.ok, true);
  assert.deepEqual(r.server, { v: 1, apiUrl: 'https://a.example', mqttUrl: 'wss://m.example/mqtt',
    turnUrl: 'turn:a.example:3478', stunUrls: ['stun:a.example:3478'], webUrl: 'https://web.example',
    name: 'Mine', links: { privacy: 'https://web.example/privacy' } });
});

await check('向伺服器要設定：錯誤分類（網址、連不到、不是 AegisTrans、設定不完整）', async () => {
  const { discoverServer } = await load('services/serverChoice.ts');
  assert.deepEqual(await discoverServer('http://a.example', fakeFetch(200, {})), { ok: false, reason: 'insecure_url' });
  assert.deepEqual(await discoverServer('nope', fakeFetch(200, {})), { ok: false, reason: 'invalid_url' });
  assert.deepEqual(await discoverServer('https://a.example', async () => { throw new Error('offline'); }), { ok: false, reason: 'unreachable' });
  assert.deepEqual(await discoverServer('https://a.example', fakeFetch(404, {})), { ok: false, reason: 'not_aegistrans' });
  assert.deepEqual(await discoverServer('https://a.example', fakeFetch(200, { service: 'other', mqtt_url: 'wss://m.example' })), { ok: false, reason: 'not_aegistrans' });
  assert.deepEqual(await discoverServer('https://a.example', fakeFetch(200, { service: 'aegistrans', mqtt_url: 'ws://m.example' })), { ok: false, reason: 'bad_config' });
  assert.deepEqual(await discoverServer('https://a.example', fakeFetch(503, {})), { ok: false, reason: 'bad_config' });
});

await check('自選伺服器存在本機；API／MQTT／ICE 都跟著換；壞掉的紀錄退回預設', async () => {
  store.clear();
  const sc = await load('services/serverChoice.ts');
  sc.saveCustomServer({ v: 1, apiUrl: 'https://a.example', mqttUrl: 'wss://m.example/mqtt', turnUrl: 'turn:t.example:3478', links: {} });
  globalThis.__platform = 'web';
  const api = await load('services/apiBase.ts');
  assert.equal(api.apiBase(), 'https://a.example', '自選伺服器在網頁版也用完整網址');
  const ice = await load('services/iceServers.ts');
  assert.deepEqual(ice.getIceServers().map((s) => s.urls), ['stun:t.example:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']);
  const fresh = await load('services/serverChoice.ts');
  assert.equal(fresh.getActiveServer().key, 'custom:https://a.example');
  assert.equal(fresh.getActiveServer().mqttUrl, 'wss://m.example/mqtt');

  store.set(sc.SERVER_STORAGE_KEY, JSON.stringify({ v: 1, apiUrl: 'http://evil.example', mqttUrl: 'wss://m.example' }));
  const bad = await load('services/serverChoice.ts');
  assert.equal(bad.getActiveServer().isDefault, true);
  store.set(sc.SERVER_STORAGE_KEY, '{not json');
  assert.equal((await load('services/serverChoice.ts')).getActiveServer().key, 'default');
});

await check('官方預設：ICE 由 turn 位址衍生 STUN（不加 TURN），其餘用公共 STUN', async () => {
  store.clear();
  const ice = await load('services/iceServers.ts');
  const host = official.turnUrl.replace(/^turns?:/, '');
  assert.deepEqual(ice.getIceServers().map((s) => s.urls), [`stun:${host}`, 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']);
  assert.ok(ice.getIceServers().every((s) => !String(s.urls).startsWith('turn')));
});

if (failures.length) {
  console.error(`\n${failures.length} 項失敗`);
  process.exit(1);
}
console.log('\n全部通過');
