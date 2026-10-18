/**
 * Electron 環境偵測 + 視窗控制 API wrapper
 *
 * Phase 2 §6.3:跨平台外觀統一(CLAUDE.md §4)— React UI 用此 util 偵測是否
 * 跑在 Capacitor Electron 殼,以決定是否 render `ElectronTitleBar`。
 *
 * **不 import electron module** — 純 window-side 偵測,確保 PWA / iOS / Android
 * build 不被 electron 依賴污染。
 */

interface AegisElectronApi {
  minimize(): Promise<void>;
  maximizeToggle(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onMaximizedChange(callback: (isMaximized: boolean) => void): () => void;
  /** Phase 3.X: main process before-quit → renderer hook for graceful MQTT shutdown */
  onGracefulShutdown?(callback: () => void): () => void;
  /** Phase 3.X: renderer → main reply when MQTT teardown finished */
  notifyShutdownDone?(): void;
  /** 桌面殼「儲存檔案」— 跳原生另存對話框寫到真實本機路徑(繞過 Capacitor 虛擬 Documents) */
  saveFile?(
    name: string,
    base64: string
  ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
  /** 桌面殼「開啟檔案」— 寫到 temp 後用系統預設 app 打開 */
  openFile?(
    name: string,
    base64: string
  ): Promise<{ ok: boolean; path?: string; error?: string }>;
  /** >2GB stream-to-disk：收檔 chunk 直接落盤（Node fs）+ 發送端從路徑串流讀。 */
  fstream?: {
    getPathForFile(file: File): string;
    prepareFileForRead(file: File): Promise<{ ok: boolean; path?: string; error?: string }>;
    open(fileId: string): Promise<{ ok: boolean; error?: string }>;
    write(fileId: string, offset: number, data: Uint8Array): Promise<{ ok: boolean; error?: string }>;
    finalize(fileId: string, expectedSha256: string, expectedSize: number, name: string): Promise<{ ok: boolean; path?: string; error?: string }>;
    abort(fileId: string): Promise<{ ok: boolean }>;
    read(path: string, offset: number, length: number): Promise<Uint8Array>;
    stat(path: string): Promise<{ size: number } | null>;
    delete(path: string): Promise<{ ok: boolean; error?: string }>;
    saveAs(path: string, suggestedName: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
    openPath(path: string): Promise<{ ok: boolean; error?: string }>;
    wipeAll(): Promise<{ ok: boolean; error?: string }>;
  };
  /** 螢幕來源選擇（多螢幕）：main 請 renderer 顯示選擇器，回傳選定 sourceId（null=取消）。 */
  onScreenPickRequest?(
    callback: (reqId: string, sources: Array<{ id: string; name: string; thumbnail: string }>) => void,
  ): () => void;
  respondScreenPick?(reqId: string, sourceId: string | null): void;
  platform: 'darwin' | 'win32' | 'linux';
  version: string;
}

declare global {
  interface Window {
    aegisElectron?: AegisElectronApi;
  }
}

/**
 * 偵測是否跑在 Capacitor Electron 殼。
 * 透過檢查 preload.ts 暴露的 `window.aegisElectron` 存在性 — PWA / iOS /
 * Android 環境永遠 false(這個 global 只在 Electron preload 設)。
 */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.aegisElectron;
}

/**
 * 取得 Electron 平台(只在 isElectron() === true 時呼叫,否則 throw)。
 */
export function getElectronPlatform(): 'darwin' | 'win32' | 'linux' {
  if (!window.aegisElectron) {
    throw new Error('getElectronPlatform called outside Electron environment');
  }
  return window.aegisElectron.platform;
}

/**
 * Mac 環境(Electron 殼跑在 macOS)— 用來判斷 ElectronTitleBar 是否要避開
 * 左上 traffic light 區(預留 80px 左 padding)。
 */
export function isElectronMac(): boolean {
  return isElectron() && getElectronPlatform() === 'darwin';
}

/**
 * 視窗控制 API — 直接 proxy 到 preload 暴露的 IPC bridge。
 * 不在 Electron 環境呼叫會 throw,呼叫端應該先 `if (isElectron())`。
 */
export const electronWindow = {
  async minimize(): Promise<void> {
    if (!window.aegisElectron) throw new Error('Not in Electron');
    return window.aegisElectron.minimize();
  },

  async maximizeToggle(): Promise<void> {
    if (!window.aegisElectron) throw new Error('Not in Electron');
    return window.aegisElectron.maximizeToggle();
  },

  async close(): Promise<void> {
    if (!window.aegisElectron) throw new Error('Not in Electron');
    return window.aegisElectron.close();
  },

  async isMaximized(): Promise<boolean> {
    if (!window.aegisElectron) return false;
    return window.aegisElectron.isMaximized();
  },

  onMaximizedChange(callback: (isMaximized: boolean) => void): () => void {
    if (!window.aegisElectron) return () => undefined;
    return window.aegisElectron.onMaximizedChange(callback);
  },
};
