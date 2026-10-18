/**
 * 裝置上限畫面（DeviceLimitGate）在 660fdbb 之後（AegisTrans 審查 G；對應 TofuTalk dd36777）：真的 auth.ts（esbuild）＋ DeviceLimitGate／App.tsx 的接線
 * （React 元件在 Node 跑不動，看原始碼）；伺服器端見 scripts/check-device-limit-gate.py。
 *   - 409 帶上這個 session 綁定的裝置 id，畫面上那一筆標成「本機」：撤銷它等於撤銷正在登入的這個 session；
 *   - 撤銷後重試註冊得到明確的撤銷（或 session 到期）→ 說明「這台的登入已失效」並請使用者重新登入，不再顯示籠統的「登入失敗」。
 * Run: node scripts/check-device-limit-gate.mjs
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
const dir = mkdtempSync(join(tmpdir(), 'devgate-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/(fingerprint|keyEncryption|apiBase)$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path.includes('apiBase') ? 'export const apiBase = () => "https://api.test";'
    : a.path.includes('fingerprint') ? 'export async function computeMachineFingerprint(){ return "fp" }'
    : 'export function clearEncryptionKey(){ return Promise.resolve(); }' }));
} };
await require('esbuild').build({ stdin: { contents: "export { registerCurrentDevice } from './services/auth.ts';", resolveDir: src, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'a.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
const { registerCurrentDevice } = await import(pathToFileURL(join(dir, 'a.mjs')));

const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
};

await check('register: the device-limit result carries the device this session is bound to', async () => {
  const devices = [{ id: 'd-old', label: 'Mac' }, { id: 'd-mine', label: 'Phone' }];
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ detail: {
    error: 'device_limit_exceeded', tier: 'free', tier_limit: 2, device_count: 2, devices, current_device_id: 'd-mine' } }) });
  const r = await registerCurrentDevice('jwt', 'PK');
  assert.equal(r.reason, 'device_limit_exceeded');
  assert.equal(r.currentDeviceId, 'd-mine', `currentDeviceId=${r.currentDeviceId}`);
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ detail: {
    error: 'device_limit_exceeded', tier: 'free', tier_limit: 2, device_count: 2, devices } }) });
  assert.equal((await registerCurrentDevice('jwt', 'PK')).currentDeviceId, null, 'older API without the field → null');
});

await check('DeviceLimitGate marks the bound device as "this device"; App passes it through', async () => {
  const gate = readFileSync(src + 'components/DeviceLimitGate.tsx', 'utf8');
  const app = readFileSync(src + 'App.tsx', 'utf8');
  assert.ok(/currentDeviceId/.test(gate), 'the gate takes a currentDeviceId prop');
  assert.ok(/d\.id === currentDeviceId[\s\S]{0,300}deviceGate\.thisDevice/.test(gate), 'the matching row shows deviceGate.thisDevice');
  const gateState = app.slice(app.indexOf("regResult.reason === 'device_limit_exceeded'"), app.indexOf('return;', app.indexOf("regResult.reason === 'device_limit_exceeded'")));
  assert.ok(/currentDeviceId: regResult\.currentDeviceId/.test(gateState), 'App keeps currentDeviceId in the gate state');
  assert.ok(/<DeviceLimitGate[\s\S]{0,600}currentDeviceId=\{deviceGate\.currentDeviceId\}/.test(app), 'App passes it to the gate');
});

await check('DeviceLimitGate: an explicit revocation (or expired session) on the retry explains it and offers to sign in again', async () => {
  const gate = readFileSync(src + 'components/DeviceLimitGate.tsx', 'utf8');
  const retry = gate.slice(gate.indexOf('const result = await registerCurrentDevice('), gate.indexOf("setError(aegisT(language, 'deviceGate.loginFailed'))"));
  assert.ok(/result\.reason === 'revoked' \|\| result\.reason === 'expired'/.test(retry), 'revoked / expired handled before the generic error');
  assert.ok(/setSignedOut\(true\)/.test(retry), 'switches the gate to the signed-out explanation');
  assert.ok(/signedOut \?[\s\S]{0,400}deviceGate\.signedOut[\s\S]{0,600}onClick=\{onCancel\}[\s\S]{0,300}deviceGate\.signInAgain/.test(gate),
    'the explanation is shown with a sign-in-again button that signs out');
  const strings = readFileSync(src + 'i18n/aegistrans-strings.ts', 'utf8');
  for (const key of ['deviceGate.signedOut', 'deviceGate.signInAgain']) {
    const line = strings.split('\n').find((l) => l.includes(`'${key}'`)) ?? '';
    for (const lang of ["'zh-TW'", "'zh-CN'", 'en:', 'ja:', 'ko:']) assert.ok(line.includes(lang), `${key} has ${lang}`);
  }
});

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall device-limit gate checks passed');
