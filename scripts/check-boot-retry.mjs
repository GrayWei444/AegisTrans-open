/**
 * 開機註冊裝置因網路失敗要自動重試（對應 TofuTalk 4d08d95）：檢查 App.tsx 的開機流程接線（App 需要瀏覽器與 React 才跑得動）。
 *   以前 registerCurrentDevice 回 network 錯就 return、註解寫「下次開機再試」，而 effect 的相依值在網路恢復後都不會變
 *   → 開 App 當下沒網路，之後整段時間沒有 MQTT／P2P（mqttService.connect、健康檢查、initPeerSync 都沒跑到；
 *   health monitor 的 online 事件也救不回來：forceReconnect 沒有 publicKey 就跳過），送訊息一直失敗。
 *   現在：排定重試（5s 起、最長 60s）並在 online 事件立刻重試；effect 依 bootRetry 重跑；清理時取消計時器與監聽。
 * Run: node scripts/check-boot-retry.mjs   （APP_SRC=<path> 可指定別份 App.tsx 做對照）
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(process.env.APP_SRC ?? join(root, 'packages/pwa/src/App.tsx'), 'utf8');
const start = app.indexOf('// === Lifecycle: 等隨機 identity ready');
assert.ok(start > 0, 'boot effect marker found');
const boot = app.slice(start, app.indexOf('\n  }, [', start) + 200);
const hardCap = boot.indexOf("regResult.reason === 'hard_cap'");
const networkBranch = boot.slice(hardCap, boot.indexOf('// 3)', hardCap));

assert.ok(/setTimeout\(retryNow,/.test(networkBranch), 'a network error schedules a retry');
assert.ok(/addEventListener\('online', retryNow/.test(networkBranch), 'coming back online retries immediately');
assert.ok(/clearTimeout\(retryTimer\)/.test(boot) && /removeEventListener\('online', retryNow\)/.test(boot), 'cleanup cancels the timer and the listener');
assert.ok(/crypto\.encrypt, bootRetry\]\);/.test(boot), 'the boot effect re-runs when bootRetry changes');
assert.ok(/Math\.min\(60_000,/.test(networkBranch), 'retries back off up to a minute');
console.log('PASS boot retries device registration after a network failure instead of waiting for the next app start');
