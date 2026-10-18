/**
 * NativeFileStream — >2GB stream-to-disk 的跨平台 renderer adapter（HANDOFF iOS/Android 階段 (a)）
 *
 * 介面 = Electron `window.aegisElectron.fstream` 的共用子集，讓 fileTransfer / tierGate /
 * fileStore / accountWipe 三平台走同一條 code path：
 *   - Electron：直接用 preload 暴露的 fstream（行為勿改 — 已 Mac/Linux 真機驗過）
 *   - iOS/Android：Capacitor plugin `AegisFileStream`（原生 random-access 寫檔；
 *     bridge 不吃 binary → chunk 走 base64，每次 call 只帶單一 chunk，native 端絕不 accumulate）
 *
 * 桌面限定能力：getPathForFile（>2GB 發送端要源檔路徑，重啟後才能續服 FILE_REQUEST）。
 * 行動端檔案選擇器拿不到原生路徑 → 行動端只支援「接收」>2GB，發送仍由桌面 App 出。
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NativeFileStream {
  /** 桌面限定：File → 原生路徑（發送 >2GB 必須；能力偵測 + 取路徑）。行動端 undefined。 */
  getPathForFile?: (file: File) => string;
  /** 桌面限定：從**真實 File** 取路徑 + 登記進 read 白名單 + 持久化，回報成敗（review P1 安全修）。
   *  renderer 只能傳 File（不能傳路徑字串）→ XSS 無法登記任意路徑。>2GB 送出前 await 它，
   *  持久化失敗 → 送出失敗（否則重啟後服務不了 FILE_REQUEST）。 */
  prepareFileForRead?: (file: File) => Promise<{ ok: boolean; path?: string; error?: string }>;
  open(fileId: string): Promise<{ ok: boolean; error?: string }>;
  write(fileId: string, offset: number, data: Uint8Array): Promise<{ ok: boolean; error?: string }>;
  finalize(fileId: string, expectedSha256: string, expectedSize: number, name: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  abort(fileId: string): Promise<{ ok: boolean }>;
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  stat(path: string): Promise<{ size: number } | null>;
  delete(path: string): Promise<{ ok: boolean; error?: string }>;
  wipeAll(): Promise<{ ok: boolean; error?: string }>;
  /** 行動端限定：檔案目錄所在 volume 的可用空間（bytes）。行動端容器空間比桌面緊，
   *  >2GB 收檔前預檢，不足就人話擋下（別下載到一半 ENOSPC）。桌面 undefined。 */
  freeBytes?(): Promise<number>;
}

// ============================================================
// Capacitor plugin 介面（iOS AegisFileStreamPlugin.swift / Android AegisFileStreamPlugin.java）
// 預期錯誤（size/sha 不符、路徑不在管理目錄內…）走 resolve({ok:false,error}) 對齊 Electron；
// reject 只留給 bridge 層意外。
// ============================================================

interface AegisFileStreamPlugin {
  open(o: { fileId: string }): Promise<{ ok: boolean; error?: string }>;
  write(o: { fileId: string; offset: number; data: string }): Promise<{ ok: boolean; error?: string }>;
  finalize(o: { fileId: string; sha256: string; size: number; name: string }): Promise<{ ok: boolean; path?: string; error?: string }>;
  abort(o: { fileId: string }): Promise<{ ok: boolean }>;
  read(o: { path: string; offset: number; length: number }): Promise<{ data: string }>;
  stat(o: { path: string }): Promise<{ exists: boolean; size: number }>;
  delete(o: { path: string }): Promise<{ ok: boolean; error?: string }>;
  wipeAll(): Promise<{ ok: boolean; error?: string }>;
  freeBytes(): Promise<{ free: number }>;
}

const CapPlugin = registerPlugin<AegisFileStreamPlugin>('AegisFileStream');

// base64 ↔ Uint8Array（單 chunk 64KB 量級，同步轉換夠快）
function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const STEP = 0x8000; // fromCharCode spread 的 arg 上限保護
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// bridge reject（plugin call.reject / bridge 意外）→ 轉 {ok:false}：呼叫端（handleChunkFrame 等）
// 只認 result.ok，reject 直接 throw 會讓 chunk 靜默消失、拖到 stall watchdog 才失敗
// （2026-07-19 Z Fold e2e：offset bug 的 reject 讓 2.3GB 傳完才 stall — 錯誤要立即浮現）。
const guarded = <T extends { ok: boolean; error?: string }>(p: Promise<T>): Promise<T> =>
  p.catch((e) => ({ ok: false, error: 'bridge: ' + String((e as Error)?.message ?? e) }) as T);

const capacitorImpl: NativeFileStream = {
  open: (fileId) => guarded(CapPlugin.open({ fileId })),
  write: (fileId, offset, data) => guarded(CapPlugin.write({ fileId, offset, data: toBase64(data) })),
  finalize: (fileId, expectedSha256, expectedSize, name) =>
    guarded(CapPlugin.finalize({ fileId, sha256: expectedSha256, size: expectedSize, name })),
  abort: (fileId) => guarded(CapPlugin.abort({ fileId })),
  read: async (path, offset, length) => fromBase64((await CapPlugin.read({ path, offset, length })).data),
  stat: async (path) => {
    const s = await CapPlugin.stat({ path });
    return s.exists ? { size: s.size } : null;
  },
  delete: (path) => CapPlugin.delete({ path }),
  wipeAll: () => CapPlugin.wipeAll(),
  freeBytes: async () => (await CapPlugin.freeBytes()).free,
};

/**
 * 取得本平台的 fs streaming 實作；不支援（web/PWA / 舊行動殼）回 undefined。
 * Electron 殼優先（Electron 也算 Capacitor native platform，但它走 Node fs IPC，效能好得多）。
 */
export function getNativeFileStream(): NativeFileStream | undefined {
  if (typeof window === 'undefined') return undefined;
  const el = window.aegisElectron?.fstream;
  if (el) return el;
  if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('AegisFileStream')) {
    return capacitorImpl;
  }
  return undefined;
}

// ============================================================
// E2E/Simulator seam — native 層自測（HANDOFF iOS 驗證路線 ①）：
// 開 stream → 亂序寫 deterministic 隨機 chunk → finalize（native 端驗 sha）→
// stat/read 抽查 → 刪檔。整個過程 JS 端每次只留一個 chunk 在記憶體。
// DEBUG_TOOLS-only；release build tree-shake。
// ============================================================

import { DEBUG_TOOLS } from '../utils/debugFlags';

if (DEBUG_TOOLS && typeof window !== 'undefined') {
  const fsStreamSelfTest = async (mb = 8): Promise<Record<string, unknown>> => {
    const fs = getNativeFileStream();
    if (!fs) return { ok: false, error: 'no native fs stream on this platform' };
    const CHUNK = 64 * 1024;
    const total = mb * 1024 * 1024;
    const count = total / CHUNK;
    const fileId = 'selftest-' + Math.random().toString(36).slice(2);
    // deterministic per-index chunk（xorshift）— 可重生成，不用把整檔留在 RAM
    const chunkAt = (i: number): Uint8Array => {
      const buf = new Uint8Array(CHUNK);
      let s = (i * 2654435761) % 4294967296 || 1;
      for (let j = 0; j < CHUNK; j++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        buf[j] = s & 0xff;
      }
      return buf;
    };
    const { createSHA256 } = await import('hash-wasm');
    const hasher = await createSHA256();
    hasher.init();
    for (let i = 0; i < count; i++) hasher.update(chunkAt(i));
    const sha = hasher.digest('hex');

    const t0 = Date.now();
    const o = await fs.open(fileId);
    if (!o.ok) return { ok: false, error: 'open: ' + o.error };
    // 亂序寫入：偶數 index 全寫完才寫奇數（模擬 chunk 亂序到達）
    const order = [...Array(count).keys()].sort((a, b) => (a % 2) - (b % 2) || a - b);
    for (const i of order) {
      const w = await fs.write(fileId, i * CHUNK, chunkAt(i));
      if (!w.ok) { await fs.abort(fileId); return { ok: false, error: `write[${i}]: ` + w.error }; }
    }
    const f = await fs.finalize(fileId, sha, total, 'selftest.bin');
    if (!f.ok || !f.path) return { ok: false, error: 'finalize: ' + f.error };
    const st = await fs.stat(f.path);
    const readBack = await fs.read(f.path, CHUNK, 16); // 抽查第 2 個 chunk 開頭
    const expected = chunkAt(1).subarray(0, 16);
    const readOk = readBack.length === 16 && readBack.every((b, i) => b === expected[i]);
    const del = await fs.delete(f.path);
    const ok = !!st && st.size === total && readOk && del.ok;
    return { ok, sizeOk: st?.size === total, readOk, deleted: del.ok, ms: Date.now() - t0, path: f.path };
  };
  // @ts-expect-error: debug seam
  window.__aegisDebug = window.__aegisDebug || {};
  // @ts-expect-error: debug seam
  window.__aegisDebug.fsStreamSelfTest = fsStreamSelfTest;
}
