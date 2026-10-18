import { Capacitor } from '@capacitor/core';
import { getActiveServer } from './serverChoice';

/**
 * API 路徑前綴（伺服器由 serverChoice 決定：預設官方，使用者可在設定改成自己的）。
 *
 * - 網頁版 + 預設伺服器：用同源路徑（官方為 `/api`）—— 網頁與 API 由同一個反向代理提供，
 *   本地 dev / preview 由 vite 的 /api proxy 轉過去。
 * - 原生（Capacitor Android/iOS）、Electron、或使用者自選的伺服器：用完整網址。
 *   Electron 的 renderer 跑在 `capacitor-electron://` 自訂 scheme，相對路徑會落到不存在的
 *   `capacitor-electron://localhost/api/*`，所以必須用完整網址；Capacitor.isNativePlatform()
 *   在 Electron 回 false，所以另外判斷 getPlatform()。
 *
 * 用法：`fetch(\`\${apiBase()}/aegistrans/auth/password/login\`)`
 */
export function apiBase(): string {
  const server = getActiveServer();
  const inBrowser = !Capacitor.isNativePlatform() && Capacitor.getPlatform() !== 'electron';
  if (inBrowser && server.isDefault && server.webApiPath) return server.webApiPath;
  return server.apiUrl;
}
