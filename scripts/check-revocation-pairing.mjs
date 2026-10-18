/**
 * 被撤銷的裝置不能再配對（稽核 B1，對應 TofuTalk 142fc5c）：真的 devicePairing.ts＋accountDevices.ts。
 *   以前 PREKEY_REQUEST／PRE_KEY_BUNDLE／X3DH_INIT 對任何 from 都回應：被撤的裝置（MQTT token ≤1h 仍有效、ACL 允許
 *   發到帳號內所有 inbox）送 PREKEY_REQUEST → 拿到 bundle → X3DH → onSessionEstablished 把「輪換後」的新金鑰派給它。
 *   現在三個 handler 都先確認對方仍是本帳號裝置；裝置清單快取可以 invalidate（roster ping／撤銷後立刻重抓）。
 * Run: node scripts/check-revocation-pairing.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'packages/pwa/src');
const require = createRequire(join(root, 'packages/pwa/package.json'));
const dir = mkdtempSync(join(tmpdir(), 'revpair-'));
globalThis.__h = {};
globalThis.__sent = [];
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/mqtt$|^\.\/crypto$|utils\/devLog$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === './mqtt' ? `export const MessageType = { X3DH_INIT: 'x3dh_init', PREKEY_REQUEST: 'prekey_request', PRE_KEY_BUNDLE: 'prekey_bundle' };
      export const mqttService = { onMessage: (t, f) => { globalThis.__h[t] = f; return () => {}; }, sendToUser: (to, type) => globalThis.__sent.push({ to, type }) };`
    : a.path === './crypto' ? 'export const fromBase64 = (s) => s; export const toBase64 = (s) => String(s);'
    : 'export const devLog=()=>{};export const devWarn=()=>{};' }));
} };
await require('esbuild').build({ stdin: { contents: `
  export * from './services/devicePairing.ts';
  export { setAccountDeviceCheck, accountDeviceCheck } from './services/accountDevices.ts';`, resolveDir: src, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'p.mjs'), logLevel: 'silent', plugins: [stub] });
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
console.error = () => {};
const m = await import(pathToFileURL(join(dir, 'p.mjs')));

// ── accountDeviceCheck：快取 + invalidate ──
let listed = ['GOOD'], fetches = 0;
const check = m.accountDeviceCheck(async () => { fetches++; return listed; });
assert.equal(await check('GOOD'), true);
listed = [];                                   // GOOD 剛被撤銷
assert.equal(await check('GOOD'), true, 'within the cache window the old list still answers');
check.invalidate();
assert.equal(await check.strict('GOOD'), false, 'after invalidate (roster ping / revoke) pairing and key messages wait for the refetch');
assert.equal(fetches, 2);
console.log('PASS account device list is cached and can be invalidated immediately');

// ── 配對 handler ──
const calls = { accept: 0, create: 0 };
m.registerCryptoFunctions({
  getPreKeyBundleData: () => ({ signedPreKeyId: 1, signedPreKeyPublic: 'spk', signedPreKeySignature: 'sig', signedPreKeyTimestamp: 1 }),
  createSession: () => { calls.create++; return { ephemeralPublicKey: 'E' }; },
  acceptSession: () => { calls.accept++; },
  hasSessionWith: () => false,
  flushSessionWrites: async () => {},
}, 'ME');
m.initDevicePairing();
m.setAccountDeviceCheck(async (pk) => pk === 'GOOD');
const h = globalThis.__h;
const bundle = { signedPreKeyId: 1, signedPreKeyPublic: 'spk', signedPreKeySignature: 'sig', signedPreKeyTimestamp: 1 };

await h.prekey_request({ from: 'REVOKED', payload: {} });
await h.prekey_bundle({ from: 'REVOKED', payload: bundle });
await h.x3dh_init({ from: 'REVOKED', payload: { ephemeralPublicKey: 'E1' } });
assert.deepEqual(globalThis.__sent, [], 'no bundle / X3DH_INIT is sent to a device that is no longer on the account');
assert.deepEqual(calls, { accept: 0, create: 0 }, 'no session is built with it');

await h.prekey_request({ from: 'GOOD', payload: {} });
await h.prekey_bundle({ from: 'GOOD', payload: bundle });
await h.x3dh_init({ from: 'GOOD', payload: { ephemeralPublicKey: 'E2' } });
assert.deepEqual(globalThis.__sent.map((s) => s.type), ['prekey_bundle', 'x3dh_init'], 'account devices still pair');
assert.deepEqual(calls, { accept: 1, create: 1 });
console.log('PASS pairing (PREKEY_REQUEST / PRE_KEY_BUNDLE / X3DH_INIT) only with current account devices');
