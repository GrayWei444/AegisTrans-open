import type { CapacitorElectronConfig } from '@capacitor-community/electron';
import {
  CapElectronEventEmitter,
  CapacitorSplashScreen,
  setupCapacitorElectronPlugins,
} from '@capacitor-community/electron';
import chokidar from 'chokidar';
import type { MenuItemConstructorOptions } from 'electron';
import { app, BrowserWindow, Menu, MenuItem, ipcMain, nativeImage, shell, systemPreferences, Tray, session, desktopCapturer, screen, dialog } from 'electron';
import electronIsDev from 'electron-is-dev';
import electronServe from 'electron-serve';
import windowStateKeeper from 'electron-window-state';
import { createHash } from 'crypto';
import { promises as fsp, createReadStream } from 'fs';
import { join, resolve as pathResolve, sep as pathSep } from 'path';

// Define components for a watcher to detect when the webapp is changed so we can reload in Dev mode.
const reloadWatcher = {
  debouncer: null,
  ready: false,
  watcher: null,
};
export function setupReloadWatcher(electronCapacitorApp: ElectronCapacitorApp): void {
  reloadWatcher.watcher = chokidar
    .watch(join(app.getAppPath(), 'app'), {
      ignored: /[/\\]\./,
      persistent: true,
    })
    .on('ready', () => {
      reloadWatcher.ready = true;
    })
    .on('all', (_event, _path) => {
      if (reloadWatcher.ready) {
        clearTimeout(reloadWatcher.debouncer);
        reloadWatcher.debouncer = setTimeout(async () => {
          electronCapacitorApp.getMainWindow().webContents.reload();
          reloadWatcher.ready = false;
          clearTimeout(reloadWatcher.debouncer);
          reloadWatcher.debouncer = null;
          reloadWatcher.watcher = null;
          setupReloadWatcher(electronCapacitorApp);
        }, 1500);
      }
    });
}

// Define our class to manage our app.
export class ElectronCapacitorApp {
  private MainWindow: BrowserWindow | null = null;
  /** ipcMain.handle 是行程級註冊，init() 因 activate 重跑時不可重複（見 init() 內註解）。 */
  private ipcHandlersRegistered = false;
  private SplashScreen: CapacitorSplashScreen | null = null;
  private TrayIcon: Tray | null = null;
  private CapacitorFileConfig: CapacitorElectronConfig;
  private TrayMenuTemplate: (MenuItem | MenuItemConstructorOptions)[] = [
    new MenuItem({ label: 'Quit App', role: 'quit' }),
  ];
  private AppMenuBarMenuTemplate: (MenuItem | MenuItemConstructorOptions)[] = [
    { role: process.platform === 'darwin' ? 'appMenu' : 'fileMenu' },
    { role: 'viewMenu' },
  ];
  private mainWindowState;
  private loadWebApp;
  private customScheme: string;

  constructor(
    capacitorFileConfig: CapacitorElectronConfig,
    trayMenuTemplate?: (MenuItemConstructorOptions | MenuItem)[],
    appMenuBarMenuTemplate?: (MenuItemConstructorOptions | MenuItem)[]
  ) {
    this.CapacitorFileConfig = capacitorFileConfig;

    this.customScheme = this.CapacitorFileConfig.electron?.customUrlScheme ?? 'capacitor-electron';

    if (trayMenuTemplate) {
      this.TrayMenuTemplate = trayMenuTemplate;
    }

    if (appMenuBarMenuTemplate) {
      this.AppMenuBarMenuTemplate = appMenuBarMenuTemplate;
    }

    // Setup our web app loader, this lets us load apps like react, vue, and angular without changing their build chains.
    this.loadWebApp = electronServe({
      directory: join(app.getAppPath(), 'app'),
      scheme: this.customScheme,
    });
  }

  // Helper function to load in the app.
  private async loadMainWindow(thisRef: any) {
    await thisRef.loadWebApp(thisRef.MainWindow);
  }

  // Expose the mainWindow ref for use outside of the class.
  getMainWindow(): BrowserWindow {
    return this.MainWindow;
  }

  getCustomURLScheme(): string {
    return this.customScheme;
  }

  async init(): Promise<void> {
    const icon = nativeImage.createFromPath(
      join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'appIcon.ico' : 'appIcon.png')
    );
    this.mainWindowState = windowStateKeeper({
      defaultWidth: 1000,
      defaultHeight: 800,
    });
    // Setup preload script path and construct our main window.
    const preloadPath = join(app.getAppPath(), 'build', 'src', 'preload.js');
    // Phase 2 §6.3：跨平台 app 外觀必須統一（CLAUDE.md §4 設計紀律）
    // - Win/Linux: frame=false 完全移除原生 chrome
    // - Mac: titleBarStyle='hiddenInset' 隱藏 title bar 但保留 traffic light(必要,Apple HIG 強制)
    // - backgroundColor 對齊 PWA 的 bg-surface-primary(navy dark theme)
    // - 不啟用 OS application menu(下方 setupMenu / Menu.setApplicationMenu(null))
    // - 配合 React UI 的 ElectronTitleBar component 跨 Mac/Win/Linux 視覺完全一致(後續 todo)
    const isMac = process.platform === 'darwin';
    this.MainWindow = new BrowserWindow({
      icon,
      show: false,
      x: this.mainWindowState.x,
      y: this.mainWindowState.y,
      width: this.mainWindowState.width,
      height: this.mainWindowState.height,
      minWidth: 800,
      minHeight: 600,
      backgroundColor: '#0d1b2a',  // 對齊 PWA bg-surface-primary
      frame: !isMac,  // Win/Linux: frameless;Mac: 留 frame 給 hiddenInset titleBar 用
      titleBarStyle: isMac ? 'hiddenInset' : 'default',  // Mac 保留 traffic light(Apple HIG 強制)
      titleBarOverlay: !isMac ? { color: '#0d1b2a', symbolColor: '#ffffff', height: 36 } : undefined,
      autoHideMenuBar: true,  // Win/Linux 隱藏 alt-toggle menubar
      webPreferences: {
        // 安全修(2026-06-05):renderer 確認零 Node API(全走 window.aegisElectron contextBridge;
        // Capacitor RT 在 preload 不在 main world)。nodeIntegration 開著會把 renderer 的 XSS 面
        // (載遠端內容 + WASM 需要的 unsafe-eval)升級成 require/child_process/fs 任意原生執行 —
        // 對隱私/E2EE 產品不可接受。關掉它把 renderer 主世界的 Node 拿掉(= S7 安全目標)。
        nodeIntegration: false,
        contextIsolation: true,
        // ⚠️ 必須明確 sandbox:false。Electron 20+ 在 nodeIntegration:false 且未指定 sandbox 時
        // 預設 sandbox=true → Capacitor electron-rt preload 用的 Node require 在 sandbox 下失敗 →
        // 整個 preload 拋錯 → window.aegisElectron(ElectronTitleBar 視窗控制)不曝露(已實測:不設
        // 此項 aegisEl=undefined、標題列壞;舊 nodeIntegration:true 時為 object)。sandbox:false 讓
        // preload 保有 Node(橋正常),renderer 主世界仍因 nodeIntegration:false 無 Node — 這是
        // Capacitor-electron 的標準安全組態。
        sandbox: false,
        // 螢幕延伸/投放黑屏修(2026-07-16):預設 backgroundThrottling=true → 視窗被遮/失焦時
        // Chromium 節流 renderer,跑在 renderer 的 WebRTC 影像 encoder 被餓死 → 停送 frame →
        // 對端全黑 → staleness timeout 自動 teardown。延伸時使用者一定會點去排列螢幕/看接收端 →
        // 本視窗被遮 → 必中。掛 DevTools(--remote-debugging-port)時 Chromium 不節流所以測不出來
        // (就是那個「port 版本正常、正式版黑屏」的差異)。app 層的 disable-renderer-backgrounding
        // 是進程優先級層級,擋不住這個每視窗 render 節流 → 必須在 webPreferences 明確關掉。
        backgroundThrottling: false,
        // Use preload to inject the electron varriant overrides for capacitor plugins.
        preload: preloadPath,
      },
    });
    this.mainWindowState.manage(this.MainWindow);

    if (this.CapacitorFileConfig.backgroundColor) {
      this.MainWindow.setBackgroundColor(this.CapacitorFileConfig.electron.backgroundColor);
    }

    // If we close the main window with the splashscreen enabled we need to destory the ref.
    this.MainWindow.on('closed', () => {
      if (this.SplashScreen?.getSplashWindow() && !this.SplashScreen.getSplashWindow().isDestroyed()) {
        this.SplashScreen.getSplashWindow().close();
      }
    });

    // When the tray icon is enabled, setup the options.
    if (this.CapacitorFileConfig.electron?.trayIconAndMenuEnabled) {
      this.TrayIcon = new Tray(icon);
      this.TrayIcon.on('double-click', () => {
        if (this.MainWindow) {
          if (this.MainWindow.isVisible()) {
            this.MainWindow.hide();
          } else {
            this.MainWindow.show();
            this.MainWindow.focus();
          }
        }
      });
      this.TrayIcon.on('click', () => {
        if (this.MainWindow) {
          if (this.MainWindow.isVisible()) {
            this.MainWindow.hide();
          } else {
            this.MainWindow.show();
            this.MainWindow.focus();
          }
        }
      });
      this.TrayIcon.setToolTip(app.getName());
      this.TrayIcon.setContextMenu(Menu.buildFromTemplate(this.TrayMenuTemplate));
    }

    // Phase 2 §6.3：跨平台外觀統一(CLAUDE.md §4)— 不啟用 OS 預設 application menu。
    // Mac 仍會自動帶最小化的 macOS app menu(無法完全移除,系統限制),但不放自家
    // File / Edit / View 等 menu items;所有功能操作走自家 React UI,跟其他平台一致。
    Menu.setApplicationMenu(null);

    // If the splashscreen is enabled, show it first while the main window loads then switch it out for the main window, or just load the main window from the start.
    if (this.CapacitorFileConfig.electron?.splashScreenEnabled) {
      this.SplashScreen = new CapacitorSplashScreen({
        imageFilePath: join(
          app.getAppPath(),
          'assets',
          this.CapacitorFileConfig.electron?.splashScreenImageName ?? 'splash.png'
        ),
        windowWidth: 400,
        windowHeight: 400,
      });
      this.SplashScreen.init(this.loadMainWindow, this);
    } else {
      this.loadMainWindow(this);
    }

    // Security
    // 安全修(2026-06-05):用 scheme 前綴比對(startsWith)而非子字串(.includes) —
    // .includes 會讓 `https://evil/?x=<scheme>` 這種挾帶 scheme 子字串的 URL 過關。
    const schemePrefix = `${this.customScheme}://`;
    this.MainWindow.webContents.setWindowOpenHandler((details) => {
      return details.url.startsWith(schemePrefix) ? { action: 'allow' } : { action: 'deny' };
    });
    this.MainWindow.webContents.on('will-navigate', (event, newURL) => {
      // 原本檢查 getURL()（當前頁,永遠是信任的 app scheme）→ 條件恆 false,從不阻擋。
      // 改檢查「導航目標」newURL,真正擋掉導去外部 origin。
      if (!newURL.startsWith(schemePrefix)) {
        event.preventDefault();
      }
    });

    // Link electron plugins into the system.
    // ⚠️ 只註冊一次：ipcMain.handle 是「行程級」註冊，Mac 關窗後點 Dock 圖示 →
    // activate → init() 重跑重建視窗 → 第二次 handle() 同 channel 直接 throw
    // 「Attempted to register a second handler for 'AegisDisplay-...'」(2026-07-21 實機回報)。
    // handlers 都是 arrow closure 讀 this.MainWindow，重建視窗後自然指向新視窗，不需重註冊。
    if (!this.ipcHandlersRegistered) {
      this.ipcHandlersRegistered = true;
      setupCapacitorElectronPlugins();

      // Phase 2 §6.3: AegisTrans 自家 window control IPC handlers
      // 對應 preload.ts 暴露的 window.aegisElectron.* API,讓 React ElectronTitleBar
      // 能跨平台一致控制視窗(min/max/close)。註冊在 dom-ready 之前以避免 race。
      this.setupWindowControlIpc();
    }

    // Phase 2 §6.2 desktop debug:把 renderer console 寫到本機檔案,ssh 進 Mac/Win 後
    // cat/type 該檔可看完整 log 流(Network Fetch / WebRTC / MQTT presence / X3DH ratchet
    // 等)。完成 debug 後可拿掉。
    //
    // Path:
    //   Mac/Linux: /tmp/aegistrans-renderer.log
    //   Windows:   %USERPROFILE%\aegistrans-renderer.log  (e.g. C:\Users\<you>\aegistrans-renderer.log)
    //              — Win 沒有 /tmp/,寫死 /tmp 會 ENOENT 被 try/catch 吞掉 → 整個 session 0 行 log
    // CR-06：renderer log 檔只在 dogfood/debug build 寫（AEGIS_DEBUG_TOOLS=1）。
    // release 預設不寫可預測的明文 log 檔（含 device id / key 片段 / WebRTC 位址）。
    if (process.env.AEGIS_DEBUG_TOOLS === '1') {
      const fs = require('fs');
      const path = require('path');
      const logPath = process.platform === 'win32'
        ? path.join(app.getPath('home'), 'aegistrans-renderer.log')
        : '/tmp/aegistrans-renderer.log';
      try {
        fs.writeFileSync(logPath, `=== AegisTrans renderer log started ${new Date().toISOString()} (platform=${process.platform}) ===\n`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[renderer-log] failed to init log file at ${logPath}:`, err);
      }
      // eslint-disable-next-line no-console
      console.error(`[renderer-log] writing to ${logPath}`);
      this.MainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        const levelStr = ['DEBUG', 'INFO', 'WARN', 'ERROR'][level] || 'UNKNOWN';
        const stamp = new Date().toISOString();
        try {
          fs.appendFileSync(logPath, `[${stamp}] [${levelStr}] ${message} (${sourceId}:${line})\n`);
        } catch {}
      });
    }

    // Phase 2 §6.2 diag flag:auto-enable diagLog in Electron shell。`diagLog`
    // (packages/pwa/src/utils/diagLog.ts) prod build 預設 no-op,只在
    // `localStorage.AEGIS_DIAG === '1'` 時才 console.error。我們的 desktop debug
    // pipeline 完全依賴 diagLog 寫的 `[DIAG:...]` events;沒這個 flag,renderer 端
    // log 檔幾乎是空的(只剩 plain console.error)。Mac 過去手動 localStorage.setItem
    // 過所以 work,Win 沒設過 → 完全空。改成 did-finish-load auto-set,Mac/Win 一致。
    if (process.env.AEGIS_DEBUG_TOOLS === '1') {
      this.MainWindow.webContents.on('did-finish-load', () => {
        this.MainWindow?.webContents.executeJavaScript(
          `try { localStorage.setItem('AEGIS_DIAG', '1'); } catch (e) { console.error('[AEGIS_DIAG] failed to set:', e); }`
        ).catch(() => { /* renderer may already be gone */ });
      });
    }

    // When the web app is loaded we hide the splashscreen if needed and show the mainwindow.
    this.MainWindow.webContents.on('dom-ready', () => {
      if (this.CapacitorFileConfig.electron?.splashScreenEnabled) {
        this.SplashScreen.getSplashWindow().hide();
      }
      if (!this.CapacitorFileConfig.electron?.hideMainWindowOnLaunch) {
        this.MainWindow.show();
      }
      setTimeout(() => {
        // CR-06：DevTools 預設 **關**（release-safe）。只在 dev 或顯式 opt-in 時開。
        // 舊行為是「除非 AEGIS_DESKTOP_DEVTOOLS==='0' 否則都開」= fail-open，已改為 opt-in。
        if (electronIsDev || process.env.AEGIS_DESKTOP_DEVTOOLS === '1') {
          this.MainWindow.webContents.openDevTools();
        }
        CapElectronEventEmitter.emit('CAPELECTRON_DeeplinkListenerInitialized', '');
      }, 400);
    });
  }

  /**
   * Phase 2 §6.3: AegisTrans 自家 window control IPC handlers
   *
   * 給 React ElectronTitleBar component 用 — 透過 preload contextBridge 暴露
   * 的 `window.aegisElectron.*` API 觸發。跨 Mac/Win/Linux 行為一致。
   *
   * Mac 上仍 honor traffic light(`titleBarStyle: 'hiddenInset'`),這些 IPC
   * 主要是 Win/Linux frameless 模式下用來模擬 OS chrome 行為的;Mac 端如果
   * React 端也 render TitleBar(避免 traffic light 區跟 React 內容重疊),仍
   * 可呼叫這些 API,行為等同。
   */
  private setupWindowControlIpc(): void {
    ipcMain.handle('aegis:window:minimize', () => {
      this.MainWindow?.minimize();
    });

    ipcMain.handle('aegis:window:maximize-toggle', () => {
      if (!this.MainWindow) return;
      if (this.MainWindow.isMaximized()) {
        this.MainWindow.unmaximize();
      } else {
        this.MainWindow.maximize();
      }
    });

    ipcMain.handle('aegis:window:close', () => {
      this.MainWindow?.close();
    });

    ipcMain.handle('aegis:window:is-maximized', (): boolean => {
      return this.MainWindow?.isMaximized() ?? false;
    });

    // 收到檔案後「儲存」— 跳原生另存對話框讓使用者選位置,寫到使用者選的真實路徑。
    // (Capacitor 的 Filesystem.writeFile(Directory.Documents) 在 Electron 是寫進
    // 看不到的虛擬 /DOCUMENTS/,Finder/檔案總管看不到 → 必須走這條 IPC。)
    // defaultPath 預設在「下載」資料夾,但使用者可自由改位置。
    ipcMain.handle('aegis:file:save', async (_e, name: string, base64: string) => {
      const win = this.MainWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const safe = String(name).replace(/[\\/]/g, '_').replace(/[\x00-\x1f]/g, '') || 'file.bin';
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: join(app.getPath('downloads'), safe),
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      try {
        await fsp.writeFile(filePath, Buffer.from(base64, 'base64'));
        return { ok: true, path: filePath };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    // 收到檔案後「開啟」— 用系統預設 app 打開。桌面殼沒有 Capacitor FileOpener
    // 原生實作,改寫到 temp 後 shell.openPath（Finder/檔案總管的「開啟方式」等價）。
    ipcMain.handle('aegis:file:open', async (_e, name: string, base64: string) => {
      try {
        const safeName = String(name).replace(/[\\/]/g, '_').replace(/[\x00-\x1f]/g, '') || 'file.bin';
        const tmpPath = join(app.getPath('temp'), `aegistrans-${Date.now()}-${safeName}`);
        await fsp.writeFile(tmpPath, Buffer.from(base64, 'base64'));
        const err = await shell.openPath(tmpPath);  // 空字串=成功
        if (err) return { ok: false, error: err };
        return { ok: true, path: tmpPath };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    // ============================================================
    // >2GB stream-to-disk（HANDOFF 步驟 2）：收檔 chunk 直接落盤，不經 IndexedDB
    // （單一 IDB Blob ~2GB 是 Chromium 硬邊界）。chunk 亂序到達 → fd.write 帶
    // explicit offset random-access 寫入。檔案存 userData/aegistrans-files/，
    // 檔名 = <fileId>-<sanitized name>（fileId 是 UUID 保證唯一；帶原名讓
    // shell.openPath 有副檔名可選 app、Finder 看得懂）。
    // ============================================================
    const filesDir = join(app.getPath('userData'), 'aegistrans-files');
    // fileId → { fd, tmpPath, chain }。chain 序列化同檔寫入（Node FileHandle
    // 並發 write 官方標註 unsafe，即使帶 explicit position）。
    const fstreams = new Map<string, { fd: import('fs/promises').FileHandle; tmpPath: string; chain: Promise<unknown> }>();
    const safeFileId = (id: string) => /^[a-zA-Z0-9-]{1,64}$/.test(id);  // UUID charset，防 path traversal
    const sanitizeName = (name: string) =>
      (String(name).replace(/[\\/]/g, '_').replace(/[\x00-\x1f:?*<>|"]/g, '_').slice(0, 120)) || 'file.bin';
    // 刪除/finalize 只允許動 filesDir 內的檔案。
    const insideFilesDir = (p: string) => pathResolve(p).startsWith(pathResolve(filesDir) + pathSep);

    // read() 白名單（review 2026-07-20 #3）：發送 >2GB 時要串流讀「使用者挑的源檔」（任意路徑），
    // 但不能讓 renderer 讀任意本機檔（XSS/供應鏈污染 → 讀 SSH key 等）。只有 preload 的
    // getPathForFile（拿得到真實 File 路徑的唯一入口，XSS 變不出指向任意路徑的真 File）會
    // 呼叫 register-read 註冊路徑；read() 只放行「filesDir 內 ∪ 已註冊路徑」。持久化到 userData
    // 讓重啟後仍能續服 FILE_REQUEST（handleFileRequest 讀 stored filePath 時該路徑仍在白名單）。
    const readablePathsFile = join(app.getPath('userData'), 'aegistrans-readable-paths.json');
    const readablePaths = new Set<string>();
    // review P2：所有 readablePaths 變更（load / register+persist / wipe）串成單一 promise chain，
    // 序列化解掉三個 race：① 並發 register 的 writeFile 互相覆蓋；② register 的 write 在 wipe unlink
    // 之後才落地 → 重建舊帳號白名單；③ 讀取類 handler 在載入前就跑 → 誤判。await 這條 chain 即
    // 「載入完成 ∧ 所有排隊中的變更已落地」。錯誤不再靜默吞掉，記 console。
    let readableChain: Promise<void> = (async () => {
      try {
        const arr = JSON.parse(await fsp.readFile(readablePathsFile, 'utf8')) as string[];
        for (const p of arr) readablePaths.add(pathResolve(p));
      } catch { /* 首次無檔 */ }
    })();
    // 回傳「這個 op」的 promise（成功/失敗都可被呼叫端 await 得知）；同時把 chain 接上一個
    // 吞掉錯誤的版本，讓後續排隊變更不因這次失敗而中斷。register handle 靠 run 的成敗回報 renderer。
    const mutateReadable = (fn: () => Promise<void>): Promise<void> => {
      const run = readableChain.then(fn);
      readableChain = run.catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[fstream] readable-paths mutation failed:', e);
      });
      return run;
    };
    // 原子寫入：先寫 .tmp 再 rename，避免 writeFile 中途失敗把 json 截斷、連帶弄丟其他已註冊路徑。
    const persistReadable = async () => {
      const tmp = readablePathsFile + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify([...readablePaths]));
      await fsp.rename(tmp, readablePathsFile);
    };
    // review P2 follow-up：改 handle（原本 fire-and-forget .on）→ **註冊+持久化的成敗回報 renderer**。
    // renderer 的 >2GB 送出流程 await 它；持久化失敗就讓送出直接失敗，不再「UI 顯示已送出、重啟卻
    // 服務不了 FILE_REQUEST」。持久化失敗回滾 in-memory add 保持與磁碟一致。
    ipcMain.handle('aegis:fstream:register-read', async (_e, p: string) => {
      if (typeof p !== 'string' || !p) return { ok: false, error: 'invalid path' };
      const resolved = pathResolve(p);
      // review P2：只回滾「本次新加入」的路徑。若路徑本來就在白名單（重複註冊），這次 persist
      // 暫時失敗**不可**刪掉既有有效授權（否則既有大檔訊息重啟後服務不了下載）。
      const alreadyHad = readablePaths.has(resolved);
      try {
        await mutateReadable(async () => {
          readablePaths.add(resolved);
          await persistReadable();
        });
        return { ok: true };
      } catch (e) {
        if (!alreadyHad) {
          await mutateReadable(async () => {
            readablePaths.delete(resolved);
            await persistReadable().catch(() => {});
          }).catch(() => {});
        }
        return { ok: false, error: (e as Error).message };
      }
    });
    const canRead = (p: string) => insideFilesDir(p) || readablePaths.has(pathResolve(p));

    ipcMain.handle('aegis:fstream:open', async (_e, fileId: string) => {
      if (!safeFileId(fileId)) return { ok: false, error: 'bad fileId' };
      try {
        await fsp.mkdir(filesDir, { recursive: true });
        const tmpPath = join(filesDir, `.tmp-${fileId}`);
        const old = fstreams.get(fileId);
        if (old) { await old.chain.catch(() => {}); await old.fd.close().catch(() => {}); }
        const fd = await fsp.open(tmpPath, 'w');
        fstreams.set(fileId, { fd, tmpPath, chain: Promise.resolve() });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    ipcMain.handle('aegis:fstream:write', async (_e, fileId: string, offset: number, data: Uint8Array) => {
      const st = fstreams.get(fileId);
      if (!st) return { ok: false, error: 'stream not open' };
      const p = st.chain.then(() => st.fd.write(data, 0, data.byteLength, offset));
      st.chain = p.catch(() => {});
      try {
        await p;
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    // finalize：close → size 驗證 → 串流算 SHA-256（Node crypto，不載整檔進 RAM）
    // → 過了 rename 到正式路徑。任何不符 → 刪 tmp 回錯誤。
    ipcMain.handle('aegis:fstream:finalize', async (_e, fileId: string, expectedSha256: string, expectedSize: number, name: string) => {
      const st = fstreams.get(fileId);
      if (!st) return { ok: false, error: 'stream not open' };
      fstreams.delete(fileId);
      try {
        await st.chain.catch(() => {});
        await st.fd.close();
        const stat = await fsp.stat(st.tmpPath);
        if (stat.size !== expectedSize) throw new Error(`size mismatch: ${stat.size} != ${expectedSize}`);
        const hash = createHash('sha256');
        await new Promise<void>((res, rej) => {
          createReadStream(st.tmpPath).on('data', (c) => hash.update(c)).on('end', res).on('error', rej);
        });
        const sha256 = hash.digest('hex');
        if (sha256 !== expectedSha256) throw new Error('sha256 mismatch');
        const finalPath = join(filesDir, `${fileId}-${sanitizeName(name)}`);
        await fsp.rename(st.tmpPath, finalPath);
        return { ok: true, path: finalPath };
      } catch (err) {
        await fsp.unlink(st.tmpPath).catch(() => {});
        return { ok: false, error: (err as Error).message };
      }
    });

    ipcMain.handle('aegis:fstream:abort', async (_e, fileId: string) => {
      const st = fstreams.get(fileId);
      if (!st) return { ok: true };
      fstreams.delete(fileId);
      await st.chain.catch(() => {});
      await st.fd.close().catch(() => {});
      await fsp.unlink(st.tmpPath).catch(() => {});
      return { ok: true };
    });

    // 讀檔片段 — 發送端串流讀源檔送 chunk / 算 hash 用。只允許「filesDir 內 ∪ 已註冊源檔」
    // （見上 readablePaths 白名單，review #3）。
    ipcMain.handle('aegis:fstream:read', async (_e, path: string, offset: number, length: number) => {
      await readableChain;  // 白名單載入前收到 FILE_REQUEST 會誤判（review P2）
      if (!canRead(path)) throw new Error('read: path not allowed');
      if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(length) || length < 0) throw new Error('read: bad offset/length');
      const fd = await fsp.open(path, 'r');
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fd.read(buf, 0, length, offset);
        return new Uint8Array(buf.buffer, 0, bytesRead);
      } finally {
        await fd.close();
      }
    });

    // stat：發送端 handleFileRequest 驗源檔還在/大小沒變用。共用 canRead 白名單（review P2）—
    // 不放行任意路徑探測（否則 renderer XSS 可拿它掃本機檔案是否存在 / 大小）。
    ipcMain.handle('aegis:fstream:stat', async (_e, path: string) => {
      await readableChain;
      if (!canRead(path)) return null;
      try {
        const s = await fsp.stat(path);
        return { size: s.size };
      } catch {
        return null;
      }
    });

    ipcMain.handle('aegis:fstream:delete', async (_e, path: string) => {
      if (!insideFilesDir(path)) return { ok: false, error: 'outside files dir' };
      await fsp.unlink(path).catch(() => {});
      return { ok: true };
    });

    // 步驟 3：fs 檔「儲存」— 原生另存對話框 + fs.copyFile（磁碟對磁碟，不過 RAM/base64）。
    // 來源共用 canRead 白名單（review P2）：只能另存「收到的檔 / 已註冊源檔」，不能把任意
    // 本機檔（SSH key 等）複製出去。目的地由使用者在原生對話框選，安全。
    ipcMain.handle('aegis:fstream:save-as', async (_e, path: string, suggestedName: string) => {
      await readableChain;
      if (!canRead(path)) return { ok: false, error: 'source not allowed' };
      const win = this.MainWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: join(app.getPath('downloads'), sanitizeName(suggestedName)),
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      try {
        await fsp.copyFile(path, filePath);
        return { ok: true, path: filePath };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    // 步驟 3：fs 檔「開啟」— 直接就地 shell.openPath（不複製 temp；>2GB 複製太貴）。
    ipcMain.handle('aegis:fstream:open-path', async (_e, path: string) => {
      if (!insideFilesDir(path)) return { ok: false, error: 'outside files dir' };
      const err = await shell.openPath(path);
      if (err) return { ok: false, error: err };
      return { ok: true };
    });

    // 換帳號 wipe：清掉整個 aegistrans-files 目錄（CR-02 跨帳號不可殘留大檔）。
    // 先關掉所有進行中的 file handle 再刪（review 2026-07-20 #6）：Windows 開啟中的檔
    // 刪不掉 → fail-closed 帳號切換被擋；Linux/macOS 留 deleted-but-open inode 到 app 結束
    // 才釋放。Android/iOS plugin 已先關 handle，Electron 保持一致。
    ipcMain.handle('aegis:fstream:wipe-all', async () => {
      for (const [, st] of fstreams) {
        await st.chain.catch(() => {});
        await st.fd.close().catch(() => {});
      }
      fstreams.clear();
      // CR-02 帳號隔離（review P2）：換帳號 wipe 必須連 read 白名單一起清 —— 否則帳號 B 沿用
      // 帳號 A 註冊過的源檔路徑，仍能透過 read/stat/save-as 讀到 A 的檔案。
      // 走 mutateReadable 串進同一條 chain 並 await：確保「載入 + 所有排隊中的 register write」都
      // 落地後才 clear+unlink，否則 in-flight 的 register 可能在 unlink 之後才把舊帳號路徑寫回檔案。
      // review P1（fail-closed）：unlink 只忽略 ENOENT（本來就沒檔）；權限/鎖定/磁碟等其他錯誤要
      // 讓整個 wipe 回 {ok:false} —— 否則白名單檔沒真的刪掉，帳號切換卻放行，重啟後又載回舊帳號白名單。
      const unlinkStrict = async (f: string) => {
        try { await fsp.unlink(f); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      };
      try {
        await mutateReadable(async () => {
          readablePaths.clear();
          await unlinkStrict(readablePathsFile);
          await unlinkStrict(readablePathsFile + '.tmp');
        });
      } catch (err) {
        return { ok: false, error: 'readable-paths wipe failed: ' + (err as Error).message };
      }
      // ponytail: 單筆刪訊息不同步移除該檔的 readable 路徑（inert：無訊息=無 FILE_REQUEST 引用它），
      // 跨帳號洩漏這個真正的邊界已由上面 wipe 清乾淨；要 per-message 精確回收再加 unregister IPC。
      try {
        await fsp.rm(filesDir, { recursive: true, force: true });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    // Phase 2 §6.2:開 macOS System Settings → Displays(讓使用者啟用延伸螢幕後
    // 一鍵看到虛擬螢幕、拖位置)。Win/Linux 不支援這個 URL,reject 即可。
    ipcMain.handle('aegis:displays:open-system-settings', () => {
      if (process.platform !== 'darwin') {
        throw new Error('Open Displays settings only supported on macOS');
      }
      // x-apple.systempreferences scheme — macOS 12+ 都認。Sequoia 15 也 work。
      return shell.openExternal('x-apple.systempreferences:com.apple.preference.displays');
    });

    // Phase 2 §6.2:給 renderer 查某個 desktopCapturer screen source 的 ID
    // (名字 partial match)。⚠️ macOS desktopCapturer 把螢幕命名為本地化的
    // 「螢幕 1」「螢幕 2」,**不會**用 CGVirtualDisplay 的自訂名 "AegisDisplay" —
    // 所以對虛擬螢幕用 name match 永遠找不到。虛擬螢幕請改用下面的
    // get-source-by-display-id。此 handler 保留給未來「依名稱抓主螢幕」等用途。
    ipcMain.handle('aegis:displays:get-source-by-name', async (_evt, name: string) => {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      // 診斷:列出每個 source 的 name + id + display_id,trace「抓不到虛擬螢幕」
      // eslint-disable-next-line no-console
      console.error(
        '[aegis:displays] get-source-by-name needle=' + JSON.stringify(name) +
          '; ' + sources.length + ' source(s): ' +
          sources.map((s) => s.name + '(id=' + s.id + ',display_id=' + s.display_id + ')').join(' | ')
      );
      const needle = String(name ?? '').toLowerCase();
      const match = sources.find((s) => s.name.toLowerCase().includes(needle));
      return match ? { id: match.id, name: match.name, display_id: match.display_id } : null;
    });

    // Phase 2 §6.2:依 CGDirectDisplayID 找 desktopCapturer screen source。
    // 這是「延伸→自動投放」抓虛擬螢幕的正解:enableVirtualDisplay 回傳的
    // displayId 是 hex CGDirectDisplayID(如 "0x0000000a"),desktopCapturer
    // 的 source.display_id 是同一個 ID 的十進位字串(如 "10")。Number() 對
    // 兩種格式都正確 parse(Number("0x0000000a") === Number("10") === 10)。
    ipcMain.handle('aegis:displays:get-source-by-display-id', async (_evt, displayId: string) => {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      const target = Number(displayId);
      // eslint-disable-next-line no-console
      console.error(
        '[aegis:displays] get-source-by-display-id needle=' + JSON.stringify(displayId) +
          ' (parsed=' + target + '); ' + sources.length + ' source(s): ' +
          sources.map((s) => s.name + '(id=' + s.id + ',display_id=' + s.display_id + ')').join(' | ')
      );
      if (!Number.isFinite(target)) return null;
      const match = sources.find((s) => Number(s.display_id) === target);
      // eslint-disable-next-line no-console
      console.error(
        '[aegis:displays] get-source-by-display-id match=' +
          (match ? match.name + '(' + match.id + ')' : 'NULL')
      );
      return match ? { id: match.id, name: match.name, display_id: match.display_id } : null;
    });

    // Phase 3 §7.1:Windows 找虛擬螢幕 source 走「次要 display」啟發式。Mac 用
    // CGDirectDisplayID(displayId 回傳值)精準 match,Windows IddCx driver 沒這個概念
    // (display 是系統 enum 順序,driver 不知道自己被分配第幾號),所以 CLI 不回 displayId。
    // 啟發式:enable 後 Electron screen.getAllDisplays() 應該多一個 non-primary;那個就是
    // AegisDisplay。如果使用者本來就有外接螢幕 + AegisDisplay → 兩個 secondary,取最後一個
    // (剛 enable 的通常最後加入)。長期解:CLI 用 Win32 EnumDisplayDevices 找 AegisDisplay
    // 對應的 display index 回傳精確 displayId,但對單外接的 dev 機足夠。
    ipcMain.handle('aegis:displays:get-virtual-display-source', async () => {
      // Electron's `screen` cache updates async via WM_DISPLAYCHANGE on Windows
      // — when the IddCx driver just attached the virtual monitor, screen.getAllDisplays()
      // may still show only the primary for up to ~3s. Poll until we see a secondary,
      // otherwise the renderer gets null + the user sees the "找不到 AegisDisplay 虛擬螢幕"
      // alert even though the driver actually worked.
      // With dynamic IddCxMonitorArrival in the driver, Windows now enumerates
      // the new monitor within ~100-300ms of CLI enable returning. Tight 50ms
      // polling lets us return as soon as enumeration completes (the old 250ms
      // interval wasted up to ~250ms on average per call). 5s ceiling kept as
      // safety against IddCx slow paths.
      const pollIntervalMs = 50;
      const maxAttempts = 100;  // 100 × 50ms = 5s
      const pollStart = Date.now();
      let allDisplays = screen.getAllDisplays();
      let primary = screen.getPrimaryDisplay();
      let secondaries = allDisplays.filter((d) => d.id !== primary.id);
      let attempts = 0;
      for (let i = 0; i < maxAttempts && secondaries.length === 0; i++) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        allDisplays = screen.getAllDisplays();
        primary = screen.getPrimaryDisplay();
        secondaries = allDisplays.filter((d) => d.id !== primary.id);
        attempts++;
      }
      const pollMs = Date.now() - pollStart;
      // eslint-disable-next-line no-console
      console.error(
        '[aegis:displays] get-virtual-display-source: primary=' + primary.id +
          ' secondaries=' + secondaries.map((d) => d.id).join(',') +
          ' totalDisplays=' + allDisplays.length +
          ' polled=' + pollMs + 'ms (' + attempts + ' attempts)'
      );
      if (secondaries.length === 0) return null;
      const target = secondaries[secondaries.length - 1];  // last added wins
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      // eslint-disable-next-line no-console
      console.error(
        '[aegis:displays] get-virtual-display-source: ' + sources.length +
          ' desktopCapturer source(s): ' +
          sources.map((s) => s.name + '(id=' + s.id + ',display_id=' + s.display_id + ')').join(' | ')
      );
      const match = sources.find((s) => Number(s.display_id) === target.id);
      // eslint-disable-next-line no-console
      console.error(
        '[aegis:displays] get-virtual-display-source target=' + target.id +
          ' match=' + (match ? match.name + '(' + match.id + ')' : 'NULL')
      );
      return match ? { id: match.id, name: match.name, display_id: match.display_id } : null;
    });

    // Phase 2 §6.2:macOS Screen Recording 權限狀態。'granted' / 'denied' /
    // 'not-determined' / 'restricted' / 'unknown'。unsigned .app 通常 not-determined
    // 直到使用者手動加進 System Settings。
    ipcMain.handle('aegis:permissions:screen-recording-status', () => {
      if (process.platform !== 'darwin') return 'granted';
      return systemPreferences.getMediaAccessStatus('screen');
    });

    // Phase 2 §6.2:打開 Screen Recording 權限面板,給沒授權的使用者一鍵跳轉。
    ipcMain.handle('aegis:permissions:open-screen-recording-settings', () => {
      if (process.platform !== 'darwin') {
        throw new Error('Screen Recording settings only on macOS');
      }
      return shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
      );
    });

    // 廣播 maximize/unmaximize 狀態變化給 renderer（更新 max ↔ restore icon）
    this.MainWindow?.on('maximize', () => {
      this.MainWindow?.webContents.send('aegis:window:maximized-changed', true);
    });
    this.MainWindow?.on('unmaximize', () => {
      this.MainWindow?.webContents.send('aegis:window:maximized-changed', false);
    });
  }
}

// Phase 2 §6.2:Electron 預設關 `navigator.mediaDevices.getDisplayMedia()` — 必須
// 在 main process 透過 setDisplayMediaRequestHandler + desktopCapturer.getSources()
// 接起來,renderer 的 web fallback (AegisDisplay.captureScreen → getDisplayMedia)
// 才能跳系統螢幕選擇 dialog。
//
// 行為:當 renderer 呼叫 getDisplayMedia,Electron callback 來這裡,我們列出可
// 用螢幕 + 窗 + 預設挑第一個(實際 production 該跳自家螢幕選擇 UI 給用戶選)。
// Phase 2 §6.2 smoke 階段先 grant 第一個讓流程跑通。
let screenPickSeq = 0; // 螢幕選擇 request 的唯一序號（多螢幕才用）
let screenPickPending = false; // 是否已有選擇器在等待（併發防護）
export function setupDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      // Phase 2 §6.2:只列「螢幕」source(types: ['screen'])— 不列 window。
      // 上一輪 (types: ['screen', 'window']) sources[0] 結果是 window enum 先回
      // 的 AegisTrans 自己視窗 → 鏡像只看到自己,死循環。改只 screens 就拿主螢幕。
      // TODO Phase 2 §6.2+:跳自家 selector UI 讓用戶選哪個螢幕 / 視窗。
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      // eslint-disable-next-line no-console
      console.error(
        '[setDisplayMediaRequestHandler] getSources returned ' + sources.length +
          ' source(s): ' + sources.map((s) => s.name).join(' | ')
      );
      if (sources.length === 0) {
        // eslint-disable-next-line no-console
        console.error(
          '[setDisplayMediaRequestHandler] No screen sources — Screen Recording permission likely revoked / stale TCC entry (adhoc-signed rebuild). Run: tccutil reset ScreenCapture com.aegisrd.aegistrans'
        );
        callback({});
        return;
      }
      // 單螢幕：直接授權主螢幕（維持原行為，零 regression — 這是已驗證的常見情況）。
      if (sources.length === 1) {
        callback({ video: sources[0] });
        return;
      }
      // 多螢幕：跳自家 in-app React 選擇器讓用戶選（不用 native dialog，符合統一 UI 原則）。
      const pickWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!pickWin) { callback({ video: sources[0] }); return; }
      // 併發防護：已有選擇器在等，就拒絕新的 request（避免 picker 被後來的覆蓋、舊 request 逾時亂授權）。
      if (screenPickPending) { callback({}); return; }
      screenPickPending = true;
      // 縮圖成本高 → 只在多螢幕時再抓一次帶縮圖的 source list。
      let payload: Array<{ id: string; name: string; thumbnail: string }>;
      try {
        const withThumbs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 200 } });
        payload = withThumbs.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
      } catch {
        payload = sources.map((s) => ({ id: s.id, name: s.name, thumbnail: '' }));
      }
      const reqId = `sp-${++screenPickSeq}`;
      const picked = await new Promise<string | null>((resolve) => {
        const channel = 'aegis:screen-pick:response';
        const onResp = (_e: unknown, rid: string, sourceId: string | null) => {
          if (rid !== reqId) return;
          ipcMain.removeListener(channel, onResp);
          clearTimeout(timer);
          resolve(sourceId);
        };
        const timer = setTimeout(() => { ipcMain.removeListener(channel, onResp); resolve(null); }, 120_000);
        ipcMain.on(channel, onResp);
        pickWin.webContents.send('aegis:screen-pick:request', reqId, payload);
      });
      screenPickPending = false;
      // 只有「明確選了有效 source」才授權；取消(null)/逾時/無效 id → callback({}) 終止分享，
      // 不擅自分享主螢幕（review：那是明確違反使用者意圖與隱私的錯誤）。
      const chosen = picked ? sources.find((s) => s.id === picked) : undefined;
      if (chosen) {
        callback({ video: chosen });
      } else {
        callback({});
      }
    } catch (err) {
      screenPickPending = false; // 別讓 throw 卡死後續選擇器
      // eslint-disable-next-line no-console
      console.error('[setDisplayMediaRequestHandler] failed:', err);
      callback({});
    }
  });
}

// Set a CSP up for our application based on the custom scheme
//
// AegisTrans-specific:預設 capacitor-electron 模板只給 customScheme://*,
// 我們需要打 backend(api / mqtt)+ WebRTC media + WASM(jeep-sqlite)。
//
// 允許清單:
//   connect-src https: wss:  → fetch / WebSocket / EventSource 到任何 HTTPS / WSS endpoint
//                                 (API / MQTT broker of the selected server, STUN HTTPS)
//   media-src blob: mediastream:  → WebRTC MediaStream + 本機 captureStream
//   script-src 'unsafe-eval' / 'wasm-unsafe-eval'  → sql-wasm.wasm + aegis-wasm
//   worker-src blob:  → service worker / Web Worker
//   img-src https: data: blob:  → 跨域圖片 + base64 + blob URL
export function setupContentSecurityPolicy(customScheme: string): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const devSuffix = electronIsDev ? ' devtools://*' : '';
    const csp = [
      `default-src ${customScheme}://*${devSuffix} 'unsafe-inline' data: blob:`,
      `connect-src ${customScheme}://*${devSuffix} https: wss: ws: data: blob:`,
      `media-src ${customScheme}://* blob: mediastream: data:`,
      `img-src ${customScheme}://* https: data: blob:`,
      `script-src ${customScheme}://*${devSuffix} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`,
      `style-src ${customScheme}://* 'unsafe-inline'`,
      `worker-src ${customScheme}://* blob:`,
      `font-src ${customScheme}://* data:`,
    ].join('; ');
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}
