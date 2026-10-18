/**
 * AegisDisplay — Capacitor Electron Native Plugin (Main Process)
 *
 * 位置:packages/aegis-display/electron/src/plugin.ts
 * 編譯目標:dist/plugin.js (CommonJS,給 @capacitor-community/electron 主程序載入)
 *
 * 角色:
 *   主程序端的 native plugin,負責呼叫 OS-specific native binary 建立 / 拆除虛擬螢幕。
 *
 *   - **macOS**:spawn `AegisDisplayHelper`(Swift,呼叫 `CGVirtualDisplayCreate`
 *     私有 API)。Helper 用 spawn-and-hold 模型:enable 留 process 活著,虛擬螢幕活
 *     在 helper 的 ARC strong ref 裡。disable 用 SIGTERM。
 *   - **Windows**:spawn `AegisDisplayControl.exe`(C++,IddCx UMDF driver 的控制 CLI)。
 *     CLI 用 fire-and-forget 模型:enable/disable/status 各自 fresh spawn → 一條
 *     JSON → exit。虛擬螢幕活在「已安裝的 IddCx driver」裡,不依賴任何 user-mode
 *     process。沒有 PID 追蹤、沒有 orphan 問題。
 *
 *   兩平台共用 src/index.ts 的 `VirtualDisplayStatus` JSON schema(同 binary 的
 *   stdout 介面)— 上層 renderer / web layer 完全不需要知道下面跑的是 Mac
 *   helper 還是 Windows CLI。
 *
 * 部署形態:
 *   electron-builder `extraResources` 把對應平台的 binary 複製到:
 *     - macOS: `<App>.app/Contents/Resources/AegisDisplayHelper`
 *     - Windows: `<App>\resources\AegisDisplay\AegisDisplayControl.exe`(+ 同層
 *       的 driver 檔 .dll / .inf / .cat,給 NSIS install 時 pnputil + devcon 用)
 *   主程序執行時 `app.isPackaged === true` 走 `process.resourcesPath`,開發時
 *   走 monorepo 內 build output 路徑。
 *
 * captureScreen() 故意**不**在這實作 — Electron renderer 跑 Chromium,
 * `navigator.mediaDevices.getDisplayMedia()` 直接通,不需要走 IPC。MediaStream
 * 物件本身也跨不了 IPC 序列化。renderer 端的 web fallback
 * (`packages/aegis-display/src/web.ts`) 處理。
 *
 * Phase 2 / 3 範圍:
 *   - macOS:Phase 2 ship(commit `94a6fd0` 起,helper 直接 CGVirtualDisplay)
 *   - Windows:Phase 3 §7.1 ship(driver fork from itsmikethetech VDD,commit `0d174ce`)
 *   - Linux:永遠不需要 helper — evdi 走 web fallback
 */

import { spawn, execFileSync, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

type DisplayResolution = '1920x1080' | '2560x1440' | '3840x2160';

interface VirtualDisplayStatus {
  supported: boolean;
  enabled: boolean;
  reason?: string;
  /** 虛擬螢幕內部識別(只有 enabled=true 才有意義) */
  displayId?: string;
  /** 啟用中的解析度 */
  resolution?: DisplayResolution;
}

interface EnableVirtualDisplayOptions {
  resolution: DisplayResolution;
}

interface ActiveHelper {
  proc: ChildProcess;
  resolution: DisplayResolution;
  displayId: string;
}

const ENABLE_JSON_TIMEOUT_MS = 10_000;
const DISABLE_KILL_TIMEOUT_MS = 3_000;
const WIN_CLI_TIMEOUT_MS = 10_000;

/**
 * 載入時間 resolve 平台對應的 native binary 路徑。讀不到就 null,後續 RPC 會 throw
 * 友善錯誤訊息。
 *
 * - darwin: AegisDisplayHelper (Mac binary)
 * - win32 : AegisDisplayControl.exe (Windows CLI)
 */
function resolveBinaryPath(): string | null {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'win32') return null;

  const candidates: string[] = [];

  // 試從 electron app module 拿 isPackaged。require 失敗(test / Node-only 環境)就退回 dev mode。
  let isPackaged = false;
  let resourcesPath: string | undefined;
  try {
    const electron = require('electron');
    const electronApp = electron.app ?? electron.remote?.app;
    if (electronApp) {
      isPackaged = electronApp.isPackaged === true;
    }
    // electron runtime 在 process 上注入 resourcesPath,標準 NodeJS.Process 型別不認;cast 取值
    resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  } catch {
    // electron 不在 → dev / 測試環境
  }

  if (platform === 'darwin') {
    if (isPackaged && resourcesPath) {
      candidates.push(path.join(resourcesPath, 'AegisDisplayHelper'));
    }
    // Dev: dist/plugin.js → ../mac/AegisDisplayHelper/.build/release/AegisDisplayHelper
    candidates.push(
      path.resolve(__dirname, '../mac/AegisDisplayHelper/.build/release/AegisDisplayHelper'),
      path.resolve(__dirname, '../../mac/AegisDisplayHelper/.build/release/AegisDisplayHelper')
    );
  } else {
    // win32
    if (isPackaged && resourcesPath) {
      candidates.push(path.join(resourcesPath, 'AegisDisplay', 'AegisDisplayControl.exe'));
    }
    // Dev: dist/plugin.js → ../win/dist/AegisDisplayControl.exe
    candidates.push(
      path.resolve(__dirname, '../win/dist/AegisDisplayControl.exe'),
      path.resolve(__dirname, '../../win/dist/AegisDisplayControl.exe')
    );
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Spawn `AegisDisplayHelper enable --resolution X` (macOS),wait for the first
 * stdout line (JSON status),resolve 然後保留 ChildProcess。helper 留下來 block 在
 * semaphore;caller 透過 disableVirtualDisplay() / app before-quit / SIGTERM
 * 控制 teardown。
 */
function spawnEnableHelper(
  helperPath: string,
  resolution: DisplayResolution
): Promise<{ proc: ChildProcess; status: VirtualDisplayStatus }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(helperPath, ['enable', '--resolution', resolution], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      proc.stdout?.removeAllListeners('data');
      proc.stderr?.removeAllListeners('data');
      proc.removeAllListeners('error');
      proc.removeAllListeners('exit');
      clearTimeout(timer);
      fn();
    };

    proc.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      const nl = stdoutBuf.indexOf('\n');
      if (nl < 0) return;
      const line = stdoutBuf.slice(0, nl).trim();
      try {
        const parsed = JSON.parse(line) as VirtualDisplayStatus;
        settle(() => resolve({ proc, status: parsed }));
      } catch {
        settle(() => {
          proc.kill('SIGTERM');
          reject(new Error(`AegisDisplayHelper enable returned non-JSON: ${line.slice(0, 200)}`));
        });
      }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    proc.on('error', (err) => {
      settle(() => reject(err));
    });

    proc.on('exit', (code, signal) => {
      settle(() =>
        reject(
          new Error(
            `AegisDisplayHelper enable exited before emitting JSON (code=${code}, signal=${signal}); stderr=${stderrBuf.trim() || '(empty)'}`
          )
        )
      );
    });

    const timer = setTimeout(() => {
      settle(() => {
        proc.kill('SIGTERM');
        reject(
          new Error(
            `AegisDisplayHelper enable timed out after ${ENABLE_JSON_TIMEOUT_MS}ms (no JSON line); stderr=${stderrBuf.trim() || '(empty)'}`
          )
        );
      });
    }, ENABLE_JSON_TIMEOUT_MS);
  });
}

/**
 * SIGTERM helper + 等 process exit。3 秒後還沒走就 SIGKILL 兜底。(macOS only)
 */
function shutdownHelper(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      resolve();
    };
    proc.once('exit', finish);
    try {
      proc.kill('SIGTERM');
    } catch {
      // process already gone
      finish();
      return;
    }
    const killTimer = setTimeout(() => {
      if (!done) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }, DISABLE_KILL_TIMEOUT_MS);
  });
}

/**
 * 殺掉系統上殘留的 AegisDisplayHelper orphan process,等它們真的退出。(macOS only)
 *
 * Orphan 來源:上次 app 啟動 hard crash / force-quit / kernel SIGKILL 沒走
 * `before-quit`,helper 被 launchd 領養繼續活著、繼續持有 CGVirtualDisplay。
 * `CGVirtualDisplay` 私有 API 一次只允許一個 display — orphan 不清掉,新的
 * `enable` spawn 會撞 `initWithDescriptor: nil`。
 *
 * **只在 `this.activeHelper === null` 時呼叫才安全**:此時這個 Electron main
 * 沒有任何合法追蹤的 helper,系統上任何 AegisDisplayHelper 一定是 orphan。
 *
 * Windows 不需要此邏輯 — driver 在 kernel,CLI 純粹 fire-and-forget。
 */
async function reapOrphanHelpers(): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('/usr/bin/pkill', ['-f', 'AegisDisplayHelper'], { stdio: 'ignore' });
  } catch {
    // pkill exit 1 = 沒有符合的 process → 沒有 orphan,直接返回
    return;
  }
  // pkill 送完 SIGTERM 就 return,但 helper dealloc CGVirtualDisplay + exit 0
  // 要一點時間。Poll 到清乾淨(或 2s 上限)再讓 caller spawn 新 helper,
  // 否則新 helper 還是會撞「舊 display 尚未釋放」。
  for (let i = 0; i < 20; i++) {
    try {
      execFileSync('/usr/bin/pgrep', ['-f', 'AegisDisplayHelper'], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      // pgrep exit 1 = 沒有 process 了 → orphan 清乾淨
      return;
    }
  }
}

/**
 * Windows: fire-and-forget spawn `AegisDisplayControl.exe <args...>`,
 * 讀一行 stdout JSON,parse,return。CLI 設計 status query never fails (exit 0
 * always),enable/disable 拿到 reason 也回 JSON,不會 throw。網路 timeout / spawn
 * 失敗才 throw。
 */
function runWindowsCli(cliPath: string, args: string[]): Promise<VirtualDisplayStatus> {
  return new Promise((resolve, reject) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;

    const proc = spawn(cliPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      proc.stdout?.removeAllListeners('data');
      proc.stderr?.removeAllListeners('data');
      proc.removeAllListeners('error');
      proc.removeAllListeners('exit');
      clearTimeout(timer);
      fn();
    };

    proc.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
    });
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    proc.on('error', (err) => settle(() => reject(err)));

    proc.on('exit', (code) => {
      settle(() => {
        const line = stdoutBuf.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
        if (!line) {
          reject(
            new Error(
              `AegisDisplayControl ${args[0]} produced no JSON (exit=${code}); stderr=${stderrBuf.trim() || '(empty)'}`
            )
          );
          return;
        }
        try {
          const parsed = JSON.parse(line) as VirtualDisplayStatus;
          resolve(parsed);
        } catch {
          reject(
            new Error(
              `AegisDisplayControl ${args[0]} returned non-JSON: ${line.slice(0, 200)}`
            )
          );
        }
      });
    });

    const timer = setTimeout(() => {
      settle(() => {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        reject(
          new Error(
            `AegisDisplayControl ${args[0]} timed out after ${WIN_CLI_TIMEOUT_MS}ms; stderr=${stderrBuf.trim() || '(empty)'}`
          )
        );
      });
    }, WIN_CLI_TIMEOUT_MS);
  });
}

/**
 * Capacitor Electron native plugin class.
 *
 * @capacitor-community/electron 把這個 module 的 named export 註冊成 plugin。
 * Plugin 名稱 ("AegisDisplay") 跟 renderer 端 `registerPlugin('AegisDisplay', ...)`
 * 對應。Method 名跟 src/index.ts 的 AegisDisplayPlugin interface 對齊。
 */
export class AegisDisplay {
  private binaryPath: string | null;
  private bound: boolean;
  /** macOS spawn-and-hold helper (null on Windows — fire-and-forget) */
  private activeHelper: ActiveHelper | null = null;

  constructor() {
    this.binaryPath = resolveBinaryPath();
    this.bound = this.binaryPath !== null;
    // eslint-disable-next-line no-console
    console.error('[AegisDisplay] ctor platform=' + process.platform + ' binaryPath=' + this.binaryPath);
    if (!this.bound && (process.platform === 'darwin' || process.platform === 'win32')) {
      const name = process.platform === 'darwin' ? 'AegisDisplayHelper' : 'AegisDisplayControl.exe';
      // eslint-disable-next-line no-console
      console.warn(
        `[AegisDisplay] ${name} binary not found in resources or dev build. ` +
          'Virtual display features disabled. Re-run the platform build to populate dist/.'
      );
    }
    this.installAppQuitHook();

    // Windows: AegisDisplay 的存在跟 AegisTrans app 生命週期綁定。app 沒開時不該有
    // 第二螢幕。Driver 的「掛/不掛 monitor」由 vdd_settings.xml 的 <count> 決定 +
    // RELOAD pipe 通知 driver re-read。所以 ctor 時主動 disable 一次:
    //   - 上次 hard-crash / 強制關 → xml 還是 count=1 → 開機 driver 自掛 → 用戶看到鬼螢幕
    //   - 正常開 app → xml 應該已經是 0,disable 是 no-op
    // 對應的 before-quit hook 也清一次,但 hook 不一定跑得到(SIGKILL / 系統 logoff)。
    if (process.platform === 'win32' && this.bound) {
      runWindowsCli(this.binaryPath!, ['disable']).then(
        (s) => {
          // eslint-disable-next-line no-console
          console.error('[AegisDisplay] startup auto-disable ok enabled=' + s.enabled);
        },
        (err) => {
          // eslint-disable-next-line no-console
          console.error('[AegisDisplay] startup auto-disable failed: ' + (err instanceof Error ? err.message : String(err)));
        }
      );
    }

    // Diag auto-trigger: 環境變數 AEGIS_AUTO_ENABLE=1 時建構完 3 秒自動跑 enable,
    // 從 .app 內部 context 重現 UI click 的呼叫路徑,給 dev/CI 用。
    if (process.env.AEGIS_AUTO_ENABLE === '1' && this.bound) {
      setTimeout(() => {
        // eslint-disable-next-line no-console
        console.error('[AegisDisplay] AUTO_ENABLE triggering');
        this.enableVirtualDisplay({ resolution: '2560x1440' })
          .then((s) => {
            // eslint-disable-next-line no-console
            console.error('[AegisDisplay] AUTO_ENABLE result=' + JSON.stringify(s));
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error(
              '[AegisDisplay] AUTO_ENABLE error: ' +
                (err instanceof Error ? err.message : String(err))
            );
          });
      }, 3000);
    }
  }

  /**
   * 查詢虛擬螢幕狀態。
   *
   * - macOS: 讀本機 state(`activeHelper`)— fresh helper status 看不到先前 spawn
   *   的 enable helper(per-process memory),round-trip 沒資訊。
   * - Windows: spawn `AegisDisplayControl.exe status` — driver 在 kernel,狀態
   *   來自 registry / xml,fresh spawn 拿得到。
   */
  async getVirtualDisplayStatus(): Promise<VirtualDisplayStatus> {
    if (process.platform === 'darwin') {
      // eslint-disable-next-line no-console
      console.error('[AegisDisplay] getVirtualDisplayStatus(darwin) binaryPath=' + this.binaryPath);
      if (!this.binaryPath) {
        return {
          supported: false,
          enabled: false,
          reason:
            'AegisDisplayHelper binary missing from app bundle. Reinstall AegisTrans desktop app.',
        };
      }
      if (this.activeHelper) {
        return {
          supported: true,
          enabled: true,
          displayId: this.activeHelper.displayId,
          resolution: this.activeHelper.resolution,
        };
      }
      return { supported: true, enabled: false };
    }

    if (process.platform === 'win32') {
      // eslint-disable-next-line no-console
      console.error('[AegisDisplay] getVirtualDisplayStatus(win32) binaryPath=' + this.binaryPath);
      if (!this.binaryPath) {
        return {
          supported: false,
          enabled: false,
          reason:
            'AegisDisplayControl.exe missing from app bundle. Reinstall AegisTrans desktop app.',
        };
      }
      return runWindowsCli(this.binaryPath, ['status']);
    }

    return {
      supported: false,
      enabled: false,
      reason: `Virtual display not supported on platform ${process.platform}.`,
    };
  }

  /**
   * 啟用虛擬螢幕。
   *
   * - macOS: spawn AegisDisplayHelper enable,helper 留下來 block,虛擬螢幕活在
   *   helper 的 ARC ref 裡。
   * - Windows: spawn AegisDisplayControl.exe enable,CLI 寫 xml + 送 pipe RELOAD,
   *   exit。虛擬螢幕活在已安裝的 IddCx driver 裡。
   */
  async enableVirtualDisplay(options: EnableVirtualDisplayOptions): Promise<VirtualDisplayStatus> {
    if (!isValidResolution(options.resolution)) {
      throw new Error(
        `Invalid resolution ${options.resolution}; must be one of 1920x1080 / 2560x1440 / 3840x2160`
      );
    }

    if (process.platform === 'darwin') {
      // eslint-disable-next-line no-console
      console.error('[AegisDisplay] enable(darwin) res=' + options.resolution + ' helperPath=' + this.binaryPath + ' activeHelper=' + (this.activeHelper ? this.activeHelper.proc.pid : 'null'));
      if (!this.binaryPath) {
        throw new Error('AegisDisplayHelper binary not available; cannot enable virtual display');
      }
      if (this.activeHelper) {
        throw new Error(
          'Virtual display already enabled; call disableVirtualDisplay first (resolution change requires a stop/start cycle)'
        );
      }
      // 走到這裡 activeHelper 確定是 null,但系統上可能還有上次 app 啟動 leak 的
      // orphan helper(hard crash / force-quit)持有 CGVirtualDisplay。不先清掉,
      // 下面 spawnEnableHelper 會撞 `initWithDescriptor: nil`(私有 API 一次只准
      // 一個 display)。
      await reapOrphanHelpers();

      let proc: ChildProcess;
      let status: VirtualDisplayStatus;
      try {
        const result = await spawnEnableHelper(this.binaryPath, options.resolution);
        proc = result.proc;
        status = result.status;
        // eslint-disable-next-line no-console
        console.error('[AegisDisplay] enable(darwin) spawn OK pid=' + proc.pid + ' status=' + JSON.stringify(status));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[AegisDisplay] enable(darwin) spawn FAILED: ' + (err instanceof Error ? err.message : String(err)));
        throw err;
      }

      const displayId = status.displayId ?? 'unknown';
      this.activeHelper = { proc, resolution: options.resolution, displayId };
      // Helper 可能因為 SIGTERM / 系統重啟 / segfault 等原因消失。一旦它退出,
      // 清掉 activeHelper 否則之後的 enable 永遠 throw alreadyEnabled。
      proc.once('exit', (code, signal) => {
        // eslint-disable-next-line no-console
        console.error('[AegisDisplay] helper PID ' + proc.pid + ' exited code=' + code + ' signal=' + signal);
        if (this.activeHelper?.proc === proc) {
          this.activeHelper = null;
        }
      });
      return status;
    }

    if (process.platform === 'win32') {
      // eslint-disable-next-line no-console
      console.error('[AegisDisplay] enable(win32) res=' + options.resolution + ' binaryPath=' + this.binaryPath);
      if (!this.binaryPath) {
        throw new Error('AegisDisplayControl.exe not available; cannot enable virtual display');
      }
      // CLI fire-and-forget;沒有「already enabled」併發保護(不需要,因為 driver
      // state 是 system-wide,xml 寫入是 atomic;重複 enable 同 resolution 是 no-op)。
      return runWindowsCli(this.binaryPath, ['enable', '--resolution', options.resolution]);
    }

    throw new Error(`enableVirtualDisplay not supported on platform ${process.platform}`);
  }

  /**
   * 停用虛擬螢幕。
   *
   * - macOS: SIGTERM 給 stored helper PID,helper 自己 dealloc CGVirtualDisplay。
   * - Windows: spawn AegisDisplayControl.exe disable,CLI 改 xml count=0 + pipe RELOAD。
   *   (註:upstream IddCx driver 的 InitAdapter 不會 detach 既有 monitor;真正
   *   要 monitor 消失要 devcon disable/enable Root\AegisDisplay。Phase 3 §7.1 follow-up。)
   */
  async disableVirtualDisplay(): Promise<VirtualDisplayStatus> {
    if (process.platform === 'darwin') {
      // eslint-disable-next-line no-console
      console.error('[AegisDisplay] disable(darwin) activeHelper=' + (this.activeHelper ? this.activeHelper.proc.pid : 'null'));
      if (!this.activeHelper) {
        return { supported: true, enabled: false };
      }
      const proc = this.activeHelper.proc;
      this.activeHelper = null; // optimistic — proc.exit 也會清,先 clear 避免併發 enable
      await shutdownHelper(proc);
      return { supported: true, enabled: false };
    }

    if (process.platform === 'win32') {
      // eslint-disable-next-line no-console
      console.error('[AegisDisplay] disable(win32) binaryPath=' + this.binaryPath);
      if (!this.binaryPath) {
        return { supported: false, enabled: false, reason: 'AegisDisplayControl.exe missing' };
      }
      return runWindowsCli(this.binaryPath, ['disable']);
    }

    throw new Error(`disableVirtualDisplay not supported on platform ${process.platform}`);
  }

  /**
   * 掛 Electron `before-quit` listener,正常退出時 SIGTERM 殘留 helper (macOS)。
   *
   * Windows 不需要 — driver 在 kernel,跟 Electron app 生命週期解耦;app 關掉
   * 虛擬螢幕還是在,要 devcon remove 或 NSIS uninstaller 才會掉。
   */
  private installAppQuitHook(): void {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;
    try {
      const { app } = require('electron');
      app.on('before-quit', () => {
        if (process.platform === 'darwin') {
          if (this.activeHelper) {
            try {
              this.activeHelper.proc.kill('SIGTERM');
            } catch {
              // already gone
            }
            this.activeHelper = null;
          }
          return;
        }
        // Windows: 同步呼叫 CLI disable,把 xml count 寫回 0 + RELOAD driver。
        // 用 execFileSync 阻塞 — Electron 會在 before-quit listener 全跑完才真的 quit,
        // 但 child process 一旦 main 結束就會被殺,所以這裡必須 sync 完成。
        if (process.platform === 'win32' && this.bound && this.binaryPath) {
          try {
            execFileSync(this.binaryPath, ['disable'], { stdio: 'ignore', timeout: 4000 });
            // eslint-disable-next-line no-console
            console.error('[AegisDisplay] before-quit disable ok');
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[AegisDisplay] before-quit disable failed: ' + (err instanceof Error ? err.message : String(err)));
          }
        }
      });
    } catch {
      // electron 不在 → 測試 / Node-only 環境,沒事
    }
  }
}

function isValidResolution(input: unknown): input is DisplayResolution {
  return input === '1920x1080' || input === '2560x1440' || input === '3840x2160';
}
