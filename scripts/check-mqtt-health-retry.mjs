/**
 * MQTT 健康監控（傳輸統一 X1／audit B3）：真的 mqttHealthMonitor.ts，stub 掉 mqtt.ts。
 *   以前連續重連失敗 5 次就停在 paused，只有切回前景（onVisibilityChange）或網路恢復
 *   （onNetworkChange）才會再試 → 桌機／Electron 視窗一直開在前景時，broker 重啟或連不上
 *   約 2.5 分鐘後就永久斷線，P2P watchdog（只在 MQTT 連線時跑）也一起停。
 *   現在：失敗 5 次後改用慢速退避（約 60s ±30%）繼續重試；連上後失敗計數歸零，回到正常退避。
 * Run: node scripts/check-mqtt-health-retry.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/pwa/package.json'));
const dir = mkdtempSync(join(tmpdir(), 'mqtthealth-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/mqtt$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, () => ({ loader: 'js', contents: `
    export const ConnectionState = { DISCONNECTED: 'disconnected', CONNECTING: 'connecting', CONNECTED: 'connected' };
    export const mqttService = globalThis.__mqtt;` }));
} };
await require('esbuild').build({ entryPoints: [join(root, 'packages/pwa/src/services/mqttHealthMonitor.ts')], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'h.mjs'), logLevel: 'silent', plugins: [stub] });

// broker.up=false 時 forceReconnect 連不上；up=true 時連得上
const broker = { up: false, connected: false, attempts: 0 };
globalThis.__mqtt = {
  getHealthInfo: () => ({ publicKey: 'A'.repeat(44), hasPinHash: true, tokenFailed: false, wsReadyState: null,
    state: broker.connected ? 'connected' : 'disconnected', clientConnected: broker.connected, lastMessageReceivedAt: 0 }),
  forceReconnect: async () => { broker.attempts++; broker.connected = broker.up; },
};
// 退避的等待不真的睡，只記錄延遲；probe 的 setInterval 不跑，由測試手動觸發
const delays = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(fn, 0); };
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
console.error = () => {};
Math.random = () => 0.5; // jitter = 0

const { mqttHealthMonitor: mon } = await import(pathToFileURL(join(dir, 'h.mjs')));
mon.start();

// 前景、網路正常、broker 一直連不上：不會有 visibility／online 事件來解除 paused
for (let i = 0; i < 8; i++) await mon._probe();
assert.equal(broker.attempts, 8, `keeps reconnecting after 5 failures while foreground (got ${broker.attempts} of 8)`);
assert.notEqual(mon.state, 'paused', 'never parks in paused while the network is online');
const slow = delays.slice(-3);
assert.ok(slow.every((d) => d >= 42_000 && d <= 78_000), `slow ~60s backoff after 5 failures (got ${slow.join(', ')}ms)`);
console.log(`PASS keeps retrying while foreground (8/8 attempts, slow backoff ${slow[0]}ms)`);

broker.up = true;
await mon._probe();                   // broker 恢復 → 慢速重試這次連上
assert.equal(broker.connected, true, 'reconnects once the broker is back');
assert.equal(mon.state, 'probing');
broker.connected = false;             // 之後又斷一次
delays.length = 0;
await mon._probe();
assert.equal(broker.attempts, 10, 'reconnects again after the next drop');
assert.equal(delays.length, 0, 'first retry after a success is immediate (failure counter was reset)');
console.log('PASS recovers and resets the failure counter');
