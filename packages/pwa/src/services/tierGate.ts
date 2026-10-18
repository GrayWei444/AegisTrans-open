/**
 * Tier Gate — 收費限制判定（1A.7）
 *
 * 兩個 gate：
 *   1. 上傳檔案：免費版總儲存 min(2GB, deviceQuota)；Pro = deviceQuota
 *   2. 裝置數量：免費 2 台 / Pro 10 台（後端 hard cap 16，這裡是更嚴格的 tier limit）
 *
 * 使用：sendFile 進入點先 await checkUploadQuota(file.size)；
 * 撞牆 → throw TierGateError → ChatInput / Settings 顯示 paywall modal。
 *
 * 設計原則：
 *   - 不阻擋現存檔案（撞牆時已存的檔案仍可開啟）
 *   - 阻擋的是「還要再寫入」(send / receive 大檔)
 *   - 升級到 Pro 後立即解鎖（subscriptionStore.refresh 後 effectiveQuota 變大）
 */

import { useSubscriptionStore } from '../stores/subscriptionStore';
import type { Tier } from './subscription';
import { getNativeFileStream } from './nativeFileStream';

export type TierGateReason = 'storage_quota_exceeded' | 'device_limit_exceeded' | 'single_file_too_large';

export interface QuotaDetails {
  used: number;
  quota: number;
  needed: number;
  tier: Tier;
}

export interface DeviceLimitDetails {
  deviceCount: number;
  tierLimit: number;
  tier: Tier;
}

export interface SingleFileDetails {
  size: number;
  limit: number;
  tier: Tier;
}

export class TierGateError extends Error {
  constructor(
    public readonly reason: TierGateReason,
    public readonly details: QuotaDetails | DeviceLimitDetails | SingleFileDetails,
  ) {
    super(reason);
    this.name = 'TierGateError';
  }
}

// ============================================
// 單檔大小 gate（>2GB stream-to-disk，2026-07 決策）
//   - web/PWA：任何 tier 都 2GB（Chromium IDB 單 Blob 硬邊界；PWA 定位=試用入口）
//   - native（Electron / iOS / Android AegisFileStream）：free 2GB、Pro 無上限
//   - 發送 >2GB 需要「源檔原生路徑」（重啟後續服 FILE_REQUEST）→ 僅桌面；
//     行動端檔案選擇器拿不到路徑 → 行動端只能「接收」>2GB
// ============================================

/** IDB 單 Blob 硬邊界 = web 與 free 的單檔上限。 */
export const SINGLE_FILE_IDB_MAX = 2 * 1024 * 1024 * 1024;

/** 本平台是否支援接收 >2GB（Electron / 有 AegisFileStream plugin 的 iOS/Android）。 */
export function isFsStreamPlatform(): boolean {
  return !!getNativeFileStream();
}

/** 本平台是否支援發送 >2GB（要拿得到源檔原生路徑 → 僅桌面 Electron）。 */
export function isFsSendPlatform(): boolean {
  return !!getNativeFileStream()?.getPathForFile;
}

/** 目前使用者在此平台的單檔上限（bytes）。 */
export function maxSingleFileBytes(): number {
  if (!isFsStreamPlatform()) return SINGLE_FILE_IDB_MAX;
  const tier = useSubscriptionStore.getState().status.tier;
  return tier === 'free' ? SINGLE_FILE_IDB_MAX : Number.MAX_SAFE_INTEGER;
}

/** 單檔大小檢查：free 在 fs-capable 平台超標 → TierGateError（UI 開 paywall）；
 *  平台能力不足（web；或行動端試圖「發送」>2GB）→ 回 'platform_limit' 讓 UI 顯示
 *  「請用 App / 請從桌面發送」提示。
 *  async：冷啟動 store 未 hydrate 時 tier 預設 free，會把 Pro 誤擋 → 比照
 *  checkUploadQuota 先 await refresh。 */
export async function checkSingleFileSize(
  size: number,
  direction: 'send' | 'receive' = 'send',
): Promise<'ok' | 'platform_limit'> {
  if (size <= SINGLE_FILE_IDB_MAX) return 'ok';
  if (direction === 'send' ? !isFsSendPlatform() : !isFsStreamPlatform()) return 'platform_limit';
  const store = useSubscriptionStore.getState();
  if (!store.hydrated) await store.refresh();
  const tier = useSubscriptionStore.getState().status.tier;
  if (tier === 'free') {
    throw new TierGateError('single_file_too_large', { size, limit: SINGLE_FILE_IDB_MAX, tier });
  }
  return 'ok';
}

export function getTierDeviceLimit(tier: Tier): number {
  return tier === 'free' ? 2 : 10;
}

/** Phase B：螢幕「發送」（投放 cast + 延伸 extend）需 Pro。接收免費、不 gate。
 *  桌面 + 行動共用此判定。回 false → caller 開 UpgradePage，不執行 capture。 */
export function isScreenSendAllowed(): boolean {
  return useSubscriptionStore.getState().status.tier !== 'free';
}

/** 上傳前檢查：本機已用 + 即將寫入的檔案大小 > effectiveQuota → 擋。
 *  refreshUsage() 先更新本機用量（避免 stale state 誤判）。 */
export async function checkUploadQuota(fileSize: number): Promise<void> {
  const store = useSubscriptionStore.getState();
  if (!store.hydrated) {
    await store.refresh();
  }
  await store.refreshUsage();
  const fresh = useSubscriptionStore.getState();
  const projected = fresh.usage.bytes + fileSize;
  if (projected > fresh.effectiveQuota) {
    throw new TierGateError('storage_quota_exceeded', {
      used: fresh.usage.bytes,
      quota: fresh.effectiveQuota,
      needed: fileSize,
      tier: fresh.status.tier,
    });
  }
}

/** 註冊新裝置前檢查（tier-aware；後端的 16 hard cap 是 tier-agnostic 安全網）。 */
export function checkDeviceLimit(deviceCount: number): void {
  const tier = useSubscriptionStore.getState().status.tier;
  const limit = getTierDeviceLimit(tier);
  if (deviceCount >= limit) {
    throw new TierGateError('device_limit_exceeded', {
      deviceCount,
      tierLimit: limit,
      tier,
    });
  }
}

export function isTierGateError(e: unknown): e is TierGateError {
  return e instanceof TierGateError;
}

// E2E test seam — 暴露 gate API 給 Playwright（非 production code path）
// CR-06/H-07：只在 dogfood/e2e build 曝露；release build tree-shake（Pro gate 不可被客端竄改）。
import { DEBUG_TOOLS } from '../utils/debugFlags';
if (DEBUG_TOOLS && typeof window !== 'undefined') {
  // @ts-expect-error: 偷塞給 window
  window.__aegisTierGate = { checkUploadQuota, checkDeviceLimit, TierGateError };
}
