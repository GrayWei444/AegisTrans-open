/**
 * main.tsx — App bootstrap
 *
 * 從 AegisTalk packages/pwa/src/main.tsx 抄結構 + 簡化：
 *
 * 保留：
 *   - Provider stack：ErrorBoundary > ConfigProvider > LanguageProvider > App
 *   - configService.initialize() — ConfigProvider 內部用
 *   - jeep-sqlite Web component
 *   - 全域錯誤捕捉（onerror / unhandledrejection / 資源載入錯誤）— iOS WebKit 隱藏錯誤需要
 *   - themeStore 模組載入（會在 init 時把 .dark / .light class 套到 <html>）
 *
 * 暫時不抄（造成 e2e flake 或 AegisTrans 沒對應路徑/服務）：
 *   - AppProvider（AegisTrans 還沒抽 providers/，邏輯在 App.tsx inline 處理）
 *   - AegisID SDK Blob Sync（沒 chatStore / groupStore）
 *   - face preload（AegisTrans 用 email + password）
 *   - remoteDebugger.enable()（endpoint 路徑寫死 AegisTalk 的 /api/api/mqtt/token，
 *     在 AegisTrans 上會 403 → 噪音 + 偶發 boot 時序干擾）
 *   - PWA visibility recovery / forceRepaint / checkAndRecover（在 Chromium 桌面跑
 *     e2e 時 focus 觸發 forceRepaint 會 race WebRTC handshake；要等真實 iOS 環境再開）
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ConfigProvider, configService } from './config';
import { LanguageProvider } from './i18n/context';
import { ErrorBoundary } from './components/ErrorBoundary';
import './stores/themeStore';
import './index.css';

import { defineCustomElements as jeepSqlite } from 'jeep-sqlite/loader';
import { devLog } from './utils/devLog';
import { DEBUG_TOOLS } from './utils/debugFlags';
jeepSqlite(window);

// 初始化配置服務（供非 React 服務使用）
configService.initialize();

// === 全域錯誤捕捉 ===
// React tree 外的致命錯誤捕捉（不會進 ErrorBoundary）

window.onerror = (message, source, lineno, colno, error) => {
  const detail = [
    `msg=${message}`,
    `src=${source}`,
    `line=${lineno}:${colno}`,
    error?.stack ? `stack=${error.stack.slice(0, 500)}` : 'no-stack',
  ].join(' | ');
  console.error(`[ERROR:onerror] ${detail}`);
  return false;
};

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  let detail: string;
  if (reason instanceof Error) {
    detail = `${reason.constructor.name}: ${reason.message}` + (reason.stack ? ` | stack: ${reason.stack.slice(0, 500)}` : '');
  } else {
    try { detail = JSON.stringify(reason); } catch { detail = String(reason); }
  }
  console.error(`[ERROR:unhandled-rejection] ${detail}`);
});

// 資源載入錯誤（img, script, link, wasm 等不會冒泡，必須 capture）
window.addEventListener('error', (event) => {
  const target = event.target as EventTarget | null;
  if (target && target !== window && target instanceof HTMLElement) {
    const tag = target.tagName;
    const src = (target as HTMLImageElement).src || (target as HTMLLinkElement).href || 'unknown';
    console.error(`[ERROR:resource] ${tag} failed to load: ${src}`);
  }
}, true);

devLog(`[AegisTrans] Starting ${configService.brand.appName} v${configService.brand.version}`);

// === Capacitor native: 清掉殘留 Service Worker + Cache Storage ===
// PWA 在瀏覽器需要 SW 做 offline cache；Capacitor APK 把所有資產 bundle 進去，
// SW 反而會把舊版 chunks 鎖住（每次 build 新 hash，但 SW 還回舊的）。
// 一旦清掉 + reload，WebView 會直接從 APK 內的 assets 載入新版 bundle。
import('@capacitor/core').then(({ Capacitor }) => {
  // 只在真實 iOS / Android Capacitor app 跑 SW-CLEAN。
  // Electron 的 isNativePlatform() 也是 true,但 Electron 走 electron-serve 不靠 SW,
  // SW-CLEAN 的 location.reload() 反而會撞掉電子殼初始載入 → ERR_ABORTED popup。
  const platform = Capacitor.getPlatform();
  // [DEBUG] dogfood / e2e build（VITE_DEBUG_TOOLS=1）才開遠端 log：
  //   diagLog → console.error → MQTT → VPS topic aegis/debug/<platform>/<deviceId8>。
  //   release build（無 flag）此整段被 tree-shake，console 不再上傳 MQTT（CR-06）。
  const autoRemoteDebug = platform === 'ios' || platform === 'android' || platform === 'electron';
  if (DEBUG_TOOLS && autoRemoteDebug) {
    try { localStorage.setItem('AEGIS_DIAG', '1'); } catch { /* ignore */ }
  }
  if (DEBUG_TOOLS) {
    import('./services/remoteDebugger').then(({ remoteDebugger }) => {
      if (autoRemoteDebug || remoteDebugger.shouldEnable()) {
        remoteDebugger.enable(`${platform}-dev`).catch(() => { /* ignore */ });
      }
    }).catch(() => { /* ignore */ });
  }
  if (platform !== 'ios' && platform !== 'android') return;
  (async () => {
    let didCleanup = false;
    if ('serviceWorker' in navigator) {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        if (regs.length > 0) {
          console.error(`[SW-CLEAN] Found ${regs.length} SW registrations on native, unregistering`);
          await Promise.all(regs.map((r) => r.unregister()));
          didCleanup = true;
        }
      } catch (e) {
        console.error(`[SW-CLEAN] unregister failed: ${(e as Error)?.message || String(e)}`);
      }
    }
    if ('caches' in window) {
      try {
        const keys = await caches.keys();
        if (keys.length > 0) {
          console.error(`[SW-CLEAN] Clearing ${keys.length} caches: ${keys.join(',')}`);
          await Promise.all(keys.map((k) => caches.delete(k)));
          didCleanup = true;
        }
      } catch (e) {
        console.error(`[SW-CLEAN] caches.delete failed: ${(e as Error)?.message || String(e)}`);
      }
    }
    if (didCleanup) {
      console.error('[SW-CLEAN] Reloading once to fetch fresh bundle from APK');
      // 用 sessionStorage 避免無限 reload loop（清完後再開不該再 reload）
      const KEY = 'aegistrans_sw_cleaned';
      if (sessionStorage.getItem(KEY) !== '1') {
        sessionStorage.setItem(KEY, '1');
        location.reload();
      } else {
        console.error('[SW-CLEAN] Already reloaded once, skipping further reloads');
      }
    }
  })();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ConfigProvider>
        <LanguageProvider>
          <App />
        </LanguageProvider>
      </ConfigProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
