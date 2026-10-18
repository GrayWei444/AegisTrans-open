import type { CapacitorElectronConfig } from '@capacitor-community/electron';
import { getCapacitorElectronConfig, setupElectronDeepLinking } from '@capacitor-community/electron';
import type { MenuItemConstructorOptions } from 'electron';
import { app, MenuItem, ipcMain } from 'electron';
import electronIsDev from 'electron-is-dev';
import unhandled from 'electron-unhandled';
import { autoUpdater } from 'electron-updater';

import { ElectronCapacitorApp, setupContentSecurityPolicy, setupDisplayMediaHandler, setupReloadWatcher } from './setup';

// Phase 3.X: stop Chromium from throttling renderer setInterval / setTimeout
// when the window is in the background. macOS App Nap + Chromium background-tab
// throttling can stretch a 10s setInterval out to 5+ minutes — that's how
// mqttHealthMonitor took ~6min to notice a dead connection on 2026-05-18.
// Disabling the throttle lets the health monitor keep probing at its
// configured 10s/30s cadence regardless of foreground state.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// 修 macOS 桌面「對話訊息列表捲動後整片空白」(只有捲動合成層凍結,周圍 UI 正常;CDP 截圖
// 照得到 = 合成器顯示層問題)。試過 use-angle=gl(Metal→OpenGL 後端)無效 → 改關硬體加速,
// 走軟體繪製,renderer 輸出即是螢幕輸出,沒有合成層凍結問題。5/21 + 5/23 實測「不會消失了」。
// ⚠️ 只在 macOS 關:Windows/Linux 沒這個 bug,全域關會無謂讓它們的螢幕分享走軟繪變慢。
// 代價(僅 Mac):螢幕分享(投放/延伸)影像走軟體繪製、效能略降(正確性優先;桌面分享是
// Pro 功能,之後若要更快可再評估更精準的 flag)。必須在 app ready 前呼叫。
if (process.platform === 'darwin') {
  app.disableHardwareAcceleration();
}

// 測試 seam：同一台機器跑第二個 instance 當「另一台裝置」（>2GB e2e 需要兩個
// Electron 端）。只有顯式設 env 才生效，正常啟動完全不受影響。
if (process.env.AEGIS_USERDATA_DIR) {
  app.setPath('userData', process.env.AEGIS_USERDATA_DIR);
}

// Graceful handling of unhandled errors.
// 但 ERR_ABORTED (-3) 是正常的 navigation interruption(reload / route 切換),
// 不跳 popup,只 log。其他 critical error 仍跳 popup。
unhandled({
  logger: (error: Error) => {
    console.error('[unhandled]', error);
  },
  showDialog: !(typeof process.env.AEGIS_DESKTOP_DEVTOOLS !== 'undefined'),
});

// Define our menu templates (these are optional)
const trayMenuTemplate: (MenuItemConstructorOptions | MenuItem)[] = [new MenuItem({ label: 'Quit App', role: 'quit' })];
const appMenuBarMenuTemplate: (MenuItemConstructorOptions | MenuItem)[] = [
  { role: process.platform === 'darwin' ? 'appMenu' : 'fileMenu' },
  { role: 'viewMenu' },
];

// Get Config options from capacitor.config
const capacitorFileConfig: CapacitorElectronConfig = getCapacitorElectronConfig();

// Initialize our app. You can pass menu templates into the app here.
// const myCapacitorApp = new ElectronCapacitorApp(capacitorFileConfig);
const myCapacitorApp = new ElectronCapacitorApp(capacitorFileConfig, trayMenuTemplate, appMenuBarMenuTemplate);

// If deeplinking is enabled then we will set it up here.
if (capacitorFileConfig.electron?.deepLinkingEnabled) {
  setupElectronDeepLinking(myCapacitorApp, {
    customProtocol: capacitorFileConfig.electron.deepLinkingCustomProtocol ?? 'mycapacitorapp',
  });
}

// If we are in Dev mode, use the file watcher components.
if (electronIsDev) {
  setupReloadWatcher(myCapacitorApp);
}

// Run Application
(async () => {
  // Wait for electron app to be ready.
  await app.whenReady();
  // Security - Set Content-Security-Policy based on whether or not we are in dev mode.
  setupContentSecurityPolicy(myCapacitorApp.getCustomURLScheme());
  // Phase 2 §6.2:wire up getDisplayMedia → desktopCapturer 讓 renderer 能擷取螢幕。
  setupDisplayMediaHandler();
  // Initialize our app, build windows, and load content.
  await myCapacitorApp.init();
  // Check for updates. Publish channel = GitHub releases (electron-builder.config.json);
  // signed packaged builds check latest.yml there. Unsigned/dev smoke builds still skip —
  // autoUpdater throws ENOENT on app-update.yml otherwise, which would kill the main process.
  try {
    autoUpdater.checkForUpdatesAndNotify().catch((err: Error) => {
      console.warn('[autoUpdater] skipped:', err.message);
    });
  } catch (err) {
    console.warn('[autoUpdater] setup failed (likely unsigned build):', err);
  }
})();

// Handle when all of our windows are close (platforms have their own expectations).
app.on('window-all-closed', function () {
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Phase 3.X: graceful MQTT presence=false on quit. Without this, Electron tears
// down the renderer + closes the MQTT TCP socket abruptly → peers learn we're
// gone only when the broker LWT fires (after keepalive timeout, 30-90s) →
// "Mac sees Win still online" stale window. With this, the renderer publishes
// presence=false with QoS 1, awaits PUBACK, then we proceed with quit — peers
// see us go offline within ~1s.
//
// Flow:
//   1. before-quit fires (preventDefault to hold quit)
//   2. send 'aegis:app:graceful-shutdown' to renderer
//   3. renderer calls mqttService.gracefulShutdown() then notifies main
//   4. main receives 'aegis:app:shutdown-done' → app.quit() actually proceeds
//   5. Hard timeout 2s in case renderer is stuck — quit anyway
let isGracefullyQuitting = false;
app.on('before-quit', (event) => {
  if (isGracefullyQuitting) return;
  const win = myCapacitorApp.getMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  event.preventDefault();
  console.error('[app] before-quit: requesting renderer to publish MQTT offline');
  win.webContents.send('aegis:app:graceful-shutdown');
  const hardTimeout = setTimeout(() => {
    console.error('[app] before-quit: renderer did not reply within 2s — quitting anyway');
    isGracefullyQuitting = true;
    app.quit();
  }, 2000);
  ipcMain.once('aegis:app:shutdown-done', () => {
    clearTimeout(hardTimeout);
    console.error('[app] before-quit: renderer reported shutdown done — quitting');
    isGracefullyQuitting = true;
    app.quit();
  });
});

// When the dock icon is clicked.
app.on('activate', async function () {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (myCapacitorApp.getMainWindow().isDestroyed()) {
    await myCapacitorApp.init();
  }
});

// Place all ipc or other electron api calls and custom functionality under this line
