/**
 * 確保 E2EE 核心 WASM 存在：src/wasm/pkg/safetalk_core.js 不在時，從 packages/crypto-core 原始碼建出來。
 *
 * 已存在就什麼都不做（不會覆蓋現有的檔案）。缺 Rust 工具鏈時印出安裝方式並中止，
 * 不讓 vite 之後才報看不懂的 module not found。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../src/wasm/pkg/safetalk_core.js');
const buildScript = resolve(here, '../../crypto-core/build.sh');

if (existsSync(entry)) process.exit(0);

if (!existsSync(buildScript)) {
  console.error(`[crypto-wasm] 找不到 ${buildScript}，無法建置 E2EE 核心。`);
  process.exit(1);
}

console.log('[crypto-wasm] src/wasm/pkg 不存在，從 packages/crypto-core 建置…');
try {
  execFileSync('bash', [buildScript, '--install'], { stdio: 'inherit' });
} catch {
  console.error('[crypto-wasm] 建置失敗。需要 rustup、wasm-pack 0.13.1 與 C linker，見 packages/crypto-core/README.md。');
  process.exit(1);
}
