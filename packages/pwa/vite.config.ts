import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';
import { existsSync, readFileSync } from 'fs';

/**
 * 私有 build 設定（deploy.private.env）：只存在私有 repo，公開匯出會排除（scripts/oss/export-public.sh）。
 * 裡面的 VITE_* 只在環境變數沒設時補上，所以命令列設的值優先。公開版沒有這個檔 → 不影響。
 * VITE_REMOTE_DEBUG_* 只在 dogfood build（VITE_DEBUG_TOOLS=1）補上：import.meta.env 整個物件會被 inline 進
 * bundle，release build 不該帶著除錯端點的字串（雖然那段程式本來就被 tree-shake）。
 */
function loadPrivateDeployEnv(): void {
  const file = path.resolve(__dirname, 'deploy.private.env');
  if (!existsSync(file)) return;
  const debugTools = process.env.VITE_DEBUG_TOOLS === '1';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = line.match(/^\s*(VITE_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    if (m[1].startsWith('VITE_REMOTE_DEBUG_') && !debugTools) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadPrivateDeployEnv();

/** 本地 dev / preview 的 /api 反代目標：自架 build 用 VITE_DEFAULT_API_URL，否則官方伺服器 */
function apiProxyTarget(mode: string): string {
  const env = loadEnv(mode, __dirname, 'VITE_');
  if (env.VITE_DEFAULT_API_URL) return env.VITE_DEFAULT_API_URL.replace(/\/+$/, '');
  const official = JSON.parse(readFileSync(path.resolve(__dirname, 'src/config/official-server.json'), 'utf8')) as { apiUrl: string };
  return official.apiUrl;
}

// mode: 'production' (default for vite build) strips console.log/warn
// mode: 'debug' (vite build --mode debug) keeps all console output for ADB debugging
export default defineConfig(({ mode }) => ({
  base: '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@components': path.resolve(__dirname, './src/components'),
      '@config': path.resolve(__dirname, './src/config'),
      '@hooks': path.resolve(__dirname, './src/hooks'),
      '@services': path.resolve(__dirname, './src/services'),
      '@stores': path.resolve(__dirname, './src/stores'),
      '@types': path.resolve(__dirname, './src/types'),
      '@utils': path.resolve(__dirname, './src/utils'),
      '@wasm': path.resolve(__dirname, './src/wasm'),
      '@plugins': path.resolve(__dirname, './src/plugins'),
    },
  },
  plugins: [
    wasm(),
    topLevelAwait(),
    react(),
    VitePWA({
      // 使用 injectManifest 以支援自定義 SW 邏輯 (Share Target POST)
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw-custom.ts',
      registerType: 'autoUpdate',
      // 強制 Service Worker 立即更新
      selfDestroying: false,
      includeAssets: ['favicon.svg', 'logo.webp', 'logo-transparent.png', 'logo-192.png', 'logo-512.png', 'logo-512-masked.png', 'splash-iphone.png', 'splash-iphone-s.png', 'splash-ipad.png', 'splash-android-xhdpi.png'],
      injectManifest: {
        // Exclude .data and .onnx (ASR models 230MB+) — load on demand, not precache
        globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm,txt}'],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024, // 10MB
      },
      manifest: {
        name: 'AegisTrans',
        short_name: 'AegisTrans',
        description: 'AegisTrans 安心傳 — 跨裝置自己對自己的訊息與檔案同步工具',
        theme_color: '#ffffff',         // 白色 — logo 統一白底（跟 PWA install icon 對齊）
        background_color: '#ffffff',    // 同上：splash screen 白底
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        lang: 'zh-TW',
        categories: ['utilities', 'productivity'],
        icons: [
          {
            src: '/logo-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/logo-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/logo-512-masked.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ],
        // Phase 14: Share Target - 接收其他 App 分享的檔案
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [
              {
                name: 'files',
                accept: [
                  'image/*',
                  'video/*',
                  'audio/*',
                  'application/pdf',
                  'application/msword',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  'application/vnd.ms-excel',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  'application/vnd.ms-powerpoint',
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                  'text/*',
                  'application/zip',
                  'application/x-rar-compressed',
                  'application/x-7z-compressed'
                ]
              }
            ]
          }
        }
      },
    }),
  ],
  optimizeDeps: {
    exclude: ['sql.js'],
  },
  server: {
    port: 5173,
    host: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // 本地 dev / E2E：把 /api 反代到預設伺服器的 API（模擬正式站反向代理 strip /api）。
    // 否則 apiBase()='/api' 在 localhost 沒對應 → fetch 落到 SPA fallback → 「網路錯誤」。
    // 只影響本地 dev/preview，不進 build 產物。
    proxy: {
      '/api': {
        target: apiProxyTarget(mode),
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  preview: {
    proxy: {
      '/api': {
        target: apiProxyTarget(mode),
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    sourcemap: false,
    // Strip console.log/warn in production — prevents sensitive data leakage in Release APK
    // Keeps console.error for real runtime errors
    minify: 'esbuild',
    // pdf.js（lazy）+ react-vendor 拆出後主 chunk ~985KB（gzip ~334KB，屬 app 核心 + crypto wasm，
    // 合理範圍）。基準設 1000KB：已拆該拆的，若主 chunk 再長超過此值代表有新的大依賴該再拆 → 才警告。
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        // code-split（review 2026-07-16）：把少變動的大型第三方庫切成獨立 chunk → 減小主 chunk
        // + 提升瀏覽器快取命中（react 版本很少變，更新 app 時使用者不必重載）。pdf.js 已另透過
        // FilePreviewModal 的 dynamic import 拆出（開 PDF 才載）。
        manualChunks(id: string) {
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return 'react-vendor';
          }
        },
      },
    },
  },
  esbuild: {
    drop: mode === 'production' ? ['debugger'] : [],
    pure: mode === 'production' ? ['console.log', 'console.warn', 'console.debug', 'console.info'] : [],
  },
  worker: {
    format: 'es',
  },
}));
