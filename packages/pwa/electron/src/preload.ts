require('./rt/electron-rt');
//////////////////////////////
// User Defined Preload scripts below

import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * Phase 2 §6.3: AegisTrans Electron 殼自家 window control bridge
 *
 * 暴露給 React renderer 用,跨平台一致的視窗操作 API。React 端用
 * `window.aegisElectron?.minimize()` 等,不存在就不 render ElectronTitleBar
 * (PWA / mobile 環境自然 fallthrough)。
 *
 * 對應 main process 端的 IPC handlers in setup.ts。
 */
const windowApi = {
  minimize: () => ipcRenderer.invoke('aegis:window:minimize'),
  maximizeToggle: () => ipcRenderer.invoke('aegis:window:maximize-toggle'),
  close: () => ipcRenderer.invoke('aegis:window:close'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('aegis:window:is-maximized'),

  /**
   * 訂閱「視窗 maximize/unmaximize 狀態變化」事件。
   * Returns 取消訂閱 fn。
   */
  onMaximizedChange: (callback: (isMaximized: boolean) => void): (() => void) => {
    const handler = (_event: unknown, isMax: boolean) => callback(isMax);
    ipcRenderer.on('aegis:window:maximized-changed', handler);
    return () => ipcRenderer.removeListener('aegis:window:maximized-changed', handler);
  },

  /**
   * Phase 2 §6.2:打開 macOS System Settings → Displays 面板。
   * 啟用虛擬螢幕後讓使用者立刻看到新螢幕、拖到主螢幕旁邊的位置。
   * Win/Linux 上 reject。
   */
  openSystemDisplaysSettings: () => ipcRenderer.invoke('aegis:displays:open-system-settings'),

  /**
   * 螢幕來源選擇（僅多螢幕觸發）。main 在 getDisplayMedia 遇到 >1 個螢幕時 emit request，
   * renderer 顯示 in-app 選擇器（不用 native dialog），選好回傳 sourceId（null=取消 → main 退回主螢幕）。
   */
  onScreenPickRequest: (
    callback: (reqId: string, sources: Array<{ id: string; name: string; thumbnail: string }>) => void,
  ): (() => void) => {
    const handler = (
      _e: unknown,
      reqId: string,
      sources: Array<{ id: string; name: string; thumbnail: string }>,
    ) => callback(reqId, sources);
    ipcRenderer.on('aegis:screen-pick:request', handler);
    return () => ipcRenderer.removeListener('aegis:screen-pick:request', handler);
  },
  respondScreenPick: (reqId: string, sourceId: string | null): void => {
    ipcRenderer.send('aegis:screen-pick:response', reqId, sourceId);
  },

  /**
   * Phase 2 §6.2:依名稱找 desktopCapturer screen source。
   * ⚠️ macOS 不會用 CGVirtualDisplay 自訂名命名 source(只給「螢幕 1/2」),
   * 抓虛擬螢幕請用 getDisplaySourceByDisplayId。
   * @return {id, name, display_id} 或 null
   */
  getDisplaySourceByName: (
    name: string
  ): Promise<{ id: string; name: string; display_id: string } | null> =>
    ipcRenderer.invoke('aegis:displays:get-source-by-name', name),

  /**
   * Phase 2 §6.2:依 CGDirectDisplayID 找 desktopCapturer screen source。
   * 延伸→自動投放抓「虛擬螢幕」的正解 — 傳 enableVirtualDisplay 回傳的
   * displayId(hex,如 "0x0000000a"),對應 desktopCapturer 的 display_id。
   * @return {id, name, display_id} 或 null
   */
  getDisplaySourceByDisplayId: (
    displayId: string
  ): Promise<{ id: string; name: string; display_id: string } | null> =>
    ipcRenderer.invoke('aegis:displays:get-source-by-display-id', displayId),

  /**
   * Phase 2 §6.2:Mac Screen Recording 權限狀態。
   * 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown' | 'unsupported'
   * (Win/Linux 一律回 'granted')
   */
  getScreenRecordingStatus: (): Promise<string> =>
    ipcRenderer.invoke('aegis:permissions:screen-recording-status'),

  /**
   * Phase 3 §7.1:Windows 用 — 找最近加入的 secondary display 對應 desktopCapturer source
   * (AegisDisplay IddCx driver 沒回 displayId,renderer 走這條 heuristic)。
   */
  getVirtualDisplaySource: (): Promise<{ id: string; name: string; display_id: string } | null> =>
    ipcRenderer.invoke('aegis:displays:get-virtual-display-source'),

  /**
   * Phase 2 §6.2:打開 Screen Recording 權限面板。沒授權的使用者一鍵跳。
   */
  openScreenRecordingSettings: (): Promise<unknown> =>
    ipcRenderer.invoke('aegis:permissions:open-screen-recording-settings'),

  /**
   * Phase 3.X:graceful-shutdown hook. Main process holds `app.quit()` and
   * dispatches `aegis:app:graceful-shutdown` so the renderer can publish
   * MQTT presence=false (QoS1 + retain) before TCP socket close. Renderer
   * calls `notifyShutdownDone()` when MQTT teardown finishes; main process
   * then proceeds with quit. A hard 2s timeout in main protects against a
   * stuck renderer (see setup.ts).
   *
   * Without this, Electron close (Cmd+Q / Alt+F4 / window-all-closed) goes
   * straight to teardown → broker LWT fires only after keepalive timeout
   * (30-90s) → peers see stale "online" presence until then.
   */
  onGracefulShutdown: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('aegis:app:graceful-shutdown', handler);
    return () => ipcRenderer.removeListener('aegis:app:graceful-shutdown', handler);
  },
  notifyShutdownDone: (): void => {
    ipcRenderer.send('aegis:app:shutdown-done');
  },

  /**
   * 收到檔案後「儲存」— 跳原生另存對話框,寫到使用者選的真實本機路徑。
   * 桌面殼不能用 Capacitor Filesystem(寫進虛擬 /DOCUMENTS/,Finder 看不到)。
   */
  saveFile: (
    name: string,
    base64: string
  ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('aegis:file:save', name, base64),

  /**
   * 收到檔案後「開啟」— 寫到 temp 後用系統預設 app 打開（shell.openPath）。
   */
  openFile: (
    name: string,
    base64: string
  ): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('aegis:file:open', name, base64),

  /**
   * >2GB stream-to-disk（HANDOFF 步驟 2）：收檔 chunk 直接 random-access 落盤
   * （Node fs，繞過 IndexedDB ~2GB Blob 硬邊界）+ 發送端從路徑串流讀 chunk。
   */
  fstream: {
    /** File → 原生路徑。Electron 32 起 File.path 移除，官方替代品就是 preload 的
     *  webUtils.getPathForFile（>2GB 發送端要路徑，重啟後才能續服 FILE_REQUEST）。 */
    getPathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file) || '';
      } catch { return ''; }
    },
    // review P1（安全回歸修正）：**只暴露這個 File-based 入口**做「取路徑 + 登記白名單 + 持久化」。
    // 路徑由 preload 內部從真實 File（webUtils.getPathForFile）取得，renderer **不得傳入路徑字串** →
    // 被 XSS 控制的 renderer 變不出指向任意檔（如 ~/.ssh/id_rsa）的真 File，無法登記任意路徑去 read。
    // 回報登記/持久化成敗；>2GB 送出流程 await 它，持久化失敗就讓送出失敗（不假成功）。
    prepareFileForRead: async (file: File): Promise<{ ok: boolean; path?: string; error?: string }> => {
      let path = '';
      try { path = webUtils.getPathForFile(file) || ''; } catch { path = ''; }
      if (!path) return { ok: false, error: 'no path for file' };
      const r = (await ipcRenderer.invoke('aegis:fstream:register-read', path)) as { ok: boolean; error?: string };
      return { ...r, path };
    },
    open: (fileId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('aegis:fstream:open', fileId),
    write: (fileId: string, offset: number, data: Uint8Array): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('aegis:fstream:write', fileId, offset, data),
    finalize: (fileId: string, expectedSha256: string, expectedSize: number, name: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('aegis:fstream:finalize', fileId, expectedSha256, expectedSize, name),
    abort: (fileId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('aegis:fstream:abort', fileId),
    read: (path: string, offset: number, length: number): Promise<Uint8Array> =>
      ipcRenderer.invoke('aegis:fstream:read', path, offset, length),
    stat: (path: string): Promise<{ size: number } | null> =>
      ipcRenderer.invoke('aegis:fstream:stat', path),
    delete: (path: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('aegis:fstream:delete', path),
    saveAs: (path: string, suggestedName: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('aegis:fstream:save-as', path, suggestedName),
    openPath: (path: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('aegis:fstream:open-path', path),
    wipeAll: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('aegis:fstream:wipe-all'),
  },
};

contextBridge.exposeInMainWorld('aegisElectron', {
  ...windowApi,
  platform: process.platform,  // 'darwin' / 'win32' / 'linux'
  version: '0.1.0',
});

console.log('[AegisTrans Electron] preload loaded — window API exposed');
