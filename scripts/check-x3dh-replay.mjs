/**
 * 重複的 X3DH_INIT 不再拆掉正常的 session（傳輸統一 X6／audit B15）：真的 devicePairing.ts＋x3dhReplay.ts。
 *   useCrypto.acceptSession 只靠記憶體裡的 acceptedEphemeralsRef 判斷「同一封 INIT 重投遞」。
 *   App 重啟後（session 已從 DB 還原、記憶體紀錄沒了）同一封 INIT 再到一次（broker QoS1 重投、
 *   被殺前沒送出 PUBACK）就走 REPLACING／forceReset：拆掉正常的 session 重建 Bob；OTP 已用掉時
 *   還會建出對不上的 session → 對方下一則 aead → 又一輪修復。
 *   現在：devicePairing 在交給 acceptSession 之前先查這把 ephemeral 是否已接受過（存 localStorage，
 *   跨重啟有效，綁帳號身分、48h、最多 500 筆）；本機已經沒有 session 時照常處理（重新接受才救得回來）。
 * 這裡的假 crypto 依 useCrypto.acceptSession 的語意：session 會落 DB（跨重啟還在），ephemeral 去重只在記憶體。
 * Run: node scripts/check-x3dh-replay.mjs
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
const esbuild = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'x3dhreplay-'));

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const handlers = new Map();
globalThis.__mqtt = {
  onMessage: (type, cb) => { handlers.set(type, cb); return () => handlers.delete(type); },
  sendToUser: () => {},
};
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/mqtt$|^\.\/crypto$|utils\/devLog$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path.endsWith('mqtt') ? `export const MessageType = { X3DH_INIT: 'x3dh_init', PREKEY_REQUEST: 'prekey_request', PRE_KEY_BUNDLE: 'prekey_bundle' };
      export const mqttService = globalThis.__mqtt;`
    : a.path.endsWith('crypto') ? 'export const fromBase64 = (s) => s; export const toBase64 = (b) => b;'
    : 'export const devLog=()=>{};export const devWarn=()=>{};' }));
} };
await esbuild.build({ entryPoints: [src('services/devicePairing.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'p.mjs'), logLevel: 'silent', plugins: [stub] });
console.error = () => {};
const pairing = await import(pathToFileURL(join(dir, 'p.mjs')));

// ── devicePairing 的 X3DH_INIT handler ──
const ME = 'M'.repeat(44), F = 'F'.repeat(44);
const sessions = new Map();          // 落 DB：跨重啟還在
let acceptedEph = new Map();         // useCrypto.acceptedEphemeralsRef：只在記憶體
const calls = { accept: 0, resets: 0, established: 0 };
let failNext = false;
const crypto = {
  getPreKeyBundleData: () => null,
  createSession: () => { throw new Error('unused'); },
  hasSessionWith: (pk) => sessions.has(pk),
  flushSessionWrites: async () => {},
  onSessionEstablished: () => { calls.established++; },
  acceptSession: (sender, eph) => {
    calls.accept++;
    if (failNext) { failNext = false; throw new Error('SignedPreKey not available'); }
    if (sessions.has(sender) && acceptedEph.get(sender) === eph) return sessions.get(sender);   // 同 ephemeral：跳過
    if (sessions.has(sender)) calls.resets++;                                                  // REPLACING：拆掉重建
    sessions.set(sender, { eph });
    acceptedEph.set(sender, eph);
    return sessions.get(sender);
  },
};
const boot = (owner = ME) => { pairing.shutdownDevicePairing(); pairing.registerCryptoFunctions(crypto, owner); pairing.initDevicePairing(); };
const restart = () => { acceptedEph = new Map(); boot(); };
const init = (eph) => handlers.get('x3dh_init')({ type: 'x3dh_init', from: F, timestamp: Date.now(),
  payload: { ephemeralPublicKey: eph, usedOneTimePrekeyId: 7, sessionReset: true } });

boot();
await init('E1');
assert.deepEqual(calls, { accept: 1, resets: 0, established: 1 }, 'first INIT is accepted');
restart();
await init('E1');                                    // 重啟後同一封又到
assert.equal(calls.resets, 0, 'a redelivered INIT after a restart leaves the working session alone');
assert.equal(calls.accept, 1, 'and is not handed to acceptSession at all');
await init('E2');
assert.deepEqual(calls, { accept: 2, resets: 1, established: 2 }, 'a new INIT (new ephemeral) still resets and re-dispatches');
restart();
await init('E1');
assert.equal(calls.resets, 1, 'an older redelivery after a newer reset is also ignored');
sessions.delete(F);
await init('E2');
assert.equal(calls.accept, 3, 'with no session left, a known INIT is processed again so the session can be rebuilt');
failNext = true;
await init('E3');                                    // acceptSession 失敗 → 不記錄
await init('E3');
assert.equal(calls.accept, 5, 'a failed accept is not recorded, so the redelivery is retried');
assert.equal(sessions.get(F).eph, 'E3');
console.log('PASS duplicate X3DH_INIT ignored before acceptSession; new INIT, lost-session and failed-accept recovery still work');

// ── x3dhReplay 模組本身：帳號隔離、過期、上限 ──
await esbuild.build({ entryPoints: [src('services/x3dhReplay.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'r.mjs'), logLevel: 'silent' });
const replay = await import(pathToFileURL(join(dir, 'r.mjs')));
store.clear();
replay.rememberAcceptedInit('me', 'peer', 'E0');
assert.equal(replay.wasInitAccepted('me', 'peer', 'E0'), true);
assert.equal(replay.wasInitAccepted('other-account', 'peer', 'E0'), false, 'records are per account identity');
assert.equal(replay.wasInitAccepted('me', 'peer', undefined), false, 'missing ephemeral never matches');
const key = [...store.keys()][0];
assert.ok(key.startsWith('aegistrans_'), `stored under an aegistrans_* key (got ${key})`);
const raw = JSON.parse(store.get(key));
raw[0].at = Date.now() - 49 * 3600_000;
store.set(key, JSON.stringify(raw));
assert.equal(replay.wasInitAccepted('me', 'peer', 'E0'), false, 'records expire after 48h (INIT freshness is 24h)');
for (let i = 0; i < 520; i++) replay.rememberAcceptedInit('me', 'peer', `E${i}`);
assert.equal(JSON.parse(store.get(key)).length, 500, 'at most 500 records kept');
assert.equal(replay.wasInitAccepted('me', 'peer', 'E519'), true, 'newest kept');
assert.equal(replay.wasInitAccepted('me', 'peer', 'E0'), false, 'oldest dropped');
store.set(key, '{not json');
assert.equal(replay.wasInitAccepted('me', 'peer', 'E519'), false, 'corrupt storage reads as empty');
console.log('PASS replay records are per account, expire after 48h, capped at 500');
