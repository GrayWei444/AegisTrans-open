/**
 * AegisTrans Device Fingerprint v4 — 純 OS / 硬體
 *
 * 設計目標：「**同一台實體機器**，不論」：
 *   - 用哪個瀏覽器（Edge / Chrome / Firefox / Safari）
 *   - 是瀏覽器 PWA 還是 Capacitor APK
 *   - **DevTools 開不開行動模擬**（很重要！測試用情境）
 *   - 是無痕 / 一般視窗
 * **都算出同一個 hash**。
 *
 * → Server 端用 fingerprint_hash dedupe，1 hardware = 1 device row。
 *
 * ⚠️ 2026-06：fingerprint **不再參與身分私鑰派生**（身分已改為隨機 Identity.generate()，
 *   私鑰加密存本機）。本檔只服務「Server 端 fingerprint_hash 裝置去重」+ deviceId（MQTT clientId）。
 *
 * v4 變更（2026-05-06）：
 *   - 砍掉 `touch` (`navigator.maxTouchPoints`) — DevTools 行動模擬會把 0 改成 5
 *   - 砍掉 `ua_platform` / `ua_arch` / `ua_bitness` (UA Client Hints) — DevTools 模擬會
 *     把 platform 從 "Windows" 改成 "Android"
 *   - 留下：`cores` (hardwareConcurrency)、`ram` (deviceMemory)、`platform_native` (navigator.platform)
 *     這 3 個 DevTools 模擬不會改、瀏覽器跨 vendor 一致、Capacitor WebView 也跟 Chrome 一致
 *
 * 衝突風險：兩台規格相同的 PC（同 cores/ram/Win32）會 hash 相同。在 self-to-self
 * 自己對自己的使用情境下，這個衝突可接受 — 通常一個帳號不會接 N 台規格完全相同的機器。
 *
 * 歷史：
 *   v3 (砍 native_id)：APK 跟 PWA 在同一支手機被算不同
 *   v2 (砍 gpu / ua_model)：Android WebGL 字串不穩、UA model 跨 vendor 不一致
 */


import { diagLog } from '../utils/diagLog';

interface FingerprintFeatures {
  cores: number;
  ram: number;
  platform_native: string;
}

let cachedFingerprint: string | null = null;
let cachedFeatures: FingerprintFeatures | null = null;

/**
 * 計算物理機 fingerprint hash（SHA-256 hex）。
 *
 * 只用 3 個欄位：
 *   - `cores` — `navigator.hardwareConcurrency`（DevTools 不改）
 *   - `ram` — `navigator.deviceMemory`（DevTools 不改）
 *   - `platform_native` — `navigator.platform` (e.g., "Win32" / "Linux armv8l" / "MacIntel")
 *     DevTools 行動模擬不會改 navigator.platform；Capacitor WebView 跟 Chrome 給同樣值。
 */
export async function computeMachineFingerprint(): Promise<string> {
  if (cachedFingerprint) return cachedFingerprint;

  const features: FingerprintFeatures = {
    cores: navigator.hardwareConcurrency || 0,
    ram: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0,
    platform_native: navigator.platform || '',
  };

  // 排序 key 後 stringify，避免 JS 物件 key 順序差異
  const sortedKeys = Object.keys(features).sort() as Array<keyof FingerprintFeatures>;
  const canonical = JSON.stringify(sortedKeys.map((k) => [k, features[k]]));

  const enc = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(canonical));
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  cachedFingerprint = hashHex;
  cachedFeatures = features;
  diagLog(`[DIAG:fp] v4 hash=${hashHex.slice(0, 16)} cores=${features.cores} ram=${features.ram} platform_native='${features.platform_native}'`);
  return hashHex;
}

/**
 * 取已計算的特徵（debug / 顯示用）。computeMachineFingerprint() 後才有值。
 */
export function getCachedFeatures(): FingerprintFeatures | null {
  return cachedFeatures;
}

/**
 * 偵測使用者「友善裝置標籤」——僅根據 platform_native，不分瀏覽器/觸控型態。
 * （給 UI 顯示用，不參與 fingerprint hash）
 */
export function inferFriendlyDeviceLabel(): string {
  if (!cachedFeatures) return '未知裝置';
  const p = cachedFeatures.platform_native;
  if (/Win/i.test(p)) return 'Windows';
  if (p === 'MacIntel' || /Mac/i.test(p)) return 'Mac';
  if (/iPhone|iPad/i.test(p)) return 'iOS';
  if (/Linux.*arm/i.test(p)) return 'Android';
  if (/Linux/i.test(p)) return 'Linux';
  return '未知裝置';
}
