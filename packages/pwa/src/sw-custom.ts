/**
 * AegisTrans Service Worker
 *
 * 主要工作：
 *   1. Workbox precache（離線資產）
 *   2. Share Target POST → 把外部分享過來的檔案轉送主畫面
 *
 * 明確不做的事（CLAUDE.md「不做推播通知」原則）：
 *   - Web Push（incoming_call / guardian_alert / message）
 *   - 來電通知 / 守護警告
 *   - MediaPipe / 臉部辨識相關 cache（AegisTalk-only，AegisTrans 沒這功能）
 *
 * 若未來真的要加 push，請另外規劃並更新隱私政策。
 *
 * 歷史：fork AegisTalk 時把整個 sw 抄過來，本檔在 2026-05-07 清掉了 push / call / guardian 殘留。
 */

/// <reference lib="webworker" />

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

declare let self: ServiceWorkerGlobalScope;

// ============================================
// Workbox precaching
// ============================================
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ============================================
// Share Target 處理（POST /share-target）
// ============================================

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);

  // 只處理 share-target 路徑的 POST 請求
  if (url.pathname === '/share-target' && event.request.method === 'POST') {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();

          // 處理檔案 — 讀為 base64 dataURL（給主畫面接手）
          const files: Array<{
            name: string;
            type: string;
            size: number;
            data: string;
          }> = [];

          const fileEntries = formData.getAll('files') as File[];
          for (const file of fileEntries) {
            try {
              const arrayBuffer = await file.arrayBuffer();
              const base64 = arrayBufferToBase64(arrayBuffer);
              const dataUrl = `data:${file.type || 'application/octet-stream'};base64,${base64}`;

              files.push({
                name: file.name,
                type: file.type || 'application/octet-stream',
                size: file.size,
                data: dataUrl,
              });
            } catch (err) {
              console.error('[SW] Failed to read file:', file.name, err);
            }
          }

          const shareData = {
            title: formData.get('title') as string | null,
            text: formData.get('text') as string | null,
            url: formData.get('url') as string | null,
            files: files.map((f, index) => ({
              id: `share_${Date.now()}_${index}`,
              name: f.name,
              mimeType: f.type,
              size: f.size,
              dataUrl: f.data,
              receivedAt: Date.now(),
            })),
          };

          // 發送資料到第一個 client
          const allClients = await self.clients.matchAll({ type: 'window' });
          if (allClients.length > 0) {
            allClients[0].postMessage({
              type: 'SHARE_TARGET_DATA',
              data: shareData,
            });
          }

          // 用 Cache API 暫存（給跨 SW-Client 大資料傳輸）+ redirect 到 share-target 頁
          const redirectUrl = new URL('/share-target', url.origin);
          redirectUrl.searchParams.set('_sw', '1');
          redirectUrl.searchParams.set('_ts', Date.now().toString());

          const cache = await caches.open('share-target-data');
          const cacheKey = `share-data-${Date.now()}`;
          await cache.put(
            cacheKey,
            new Response(JSON.stringify(shareData), {
              headers: { 'Content-Type': 'application/json' },
            })
          );
          redirectUrl.searchParams.set('_cache', cacheKey);

          return Response.redirect(redirectUrl.toString(), 303);
        } catch (err) {
          console.error('[SW] Share Target error:', err);
          return Response.redirect('/', 303);
        }
      })()
    );
  }
});

// ArrayBuffer 轉 Base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ============================================
// SW 生命週期
// ============================================

// 不 skipWaiting — 等所有 tab 關閉自然接管，避免 iOS Safari reload 清 localStorage
self.addEventListener('install', () => {
  console.log('[SW] Installed — will activate on next app launch');
});

self.addEventListener('activate', (event) => {
  event.waitUntil(purgeStaleShareTargetCache());
  console.log('[SW] Activated');
});

/** Remove share-target-data cache entries older than 1 hour */
async function purgeStaleShareTargetCache(): Promise<void> {
  try {
    const cache = await caches.open('share-target-data');
    const keys = await cache.keys();
    const ONE_HOUR = 60 * 60 * 1000;
    for (const request of keys) {
      const response = await cache.match(request);
      if (!response) { await cache.delete(request); continue; }
      const urlPath = new URL(request.url).pathname;
      const tsMatch = urlPath.match(/share-data-(\d+)/);
      if (tsMatch) {
        const ts = parseInt(tsMatch[1], 10);
        if (Date.now() - ts > ONE_HOUR) {
          await cache.delete(request);
        }
      }
    }
  } catch {
    // Cache API unavailable — ignore
  }
}
