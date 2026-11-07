/**
 * Tier Gate — 收費限制判定
 *
 * 2026-11-06 Gray 改成「沒有免費版：商店免費試用 14 天 → 訂閱」：
 *   1. 官方伺服器：未訂閱（含試用到期）不能傳送檔案、文字、螢幕 → requireSubscription()
 *      試用／訂閱到期後 App 跳關不掉的訂閱卡（SubscriptionNudge.TrialOfferCard，Gray 11-06）
 *   2. 自架伺服器（設定裡換伺服器、或 VITE_DEFAULT_API_URL build）不收費 —— 賣的是官方服務
 *   3. 裝置數量：一律 10 台（後端寫死，hard cap 16；未訂閱也要能登入才看得到試用）
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
import { getActiveServer } from './serverChoice';

export type TierGateReason = 'storage_quota_exceeded' | 'device_limit_exceeded' | 'subscription_required';

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

export interface SubscriptionDetails {
  tier: Tier;
}

export type TierGateDetails = QuotaDetails | DeviceLimitDetails | SubscriptionDetails;

export class TierGateError extends Error {
  constructor(
    public readonly reason: TierGateReason,
    public readonly details: TierGateDetails,
  ) {
    super(reason);
    this.name = 'TierGateError';
  }
}

/** 只有官方伺服器收費。 */
export function billingApplies(): boolean {
  return getActiveServer().isOfficial;
}

/** 傳送（檔案／文字）前呼叫：官方伺服器上未訂閱 → TierGateError('subscription_required')。 */
export async function requireSubscription(): Promise<void> {
  if (!billingApplies()) return;
  const store = useSubscriptionStore.getState();
  if (!store.hydrated) await store.refresh();
  const s = useSubscriptionStore.getState();
  // ponytail: 斷網問不到權威答案（hydrated 仍 false）時放行，不讓付費用戶冷啟動被誤擋；
  // 這是 client 端 gate，伺服器端只擋裝置數。要硬擋得在 MQTT token 簽發時查訂閱。
  if (!s.hydrated || s.status.isPro) return;
  throw new TierGateError('subscription_required', { tier: s.status.tier });
}

// ============================================
// 單檔大小 gate（>2GB stream-to-disk，2026-07 決策）
//   - web/PWA：一律 2GB（Chromium IDB 單 Blob 硬邊界）
//   - native（Electron / iOS / Android AegisFileStream）：不限（官方伺服器要有訂閱）
//   - 發送 >2GB 需要「源檔原生路徑」（重啟後續服 FILE_REQUEST）→ 僅桌面；
//     行動端檔案選擇器拿不到路徑 → 行動端只能「接收」>2GB
// ============================================

/** IDB 單 Blob 硬邊界 = web 的單檔上限。 */
export const SINGLE_FILE_IDB_MAX = 2 * 1024 * 1024 * 1024;

/** 本平台是否支援接收 >2GB（Electron / 有 AegisFileStream plugin 的 iOS/Android）。 */
export function isFsStreamPlatform(): boolean {
  return !!getNativeFileStream();
}

/** 本平台是否支援發送 >2GB（要拿得到源檔原生路徑 → 僅桌面 Electron）。 */
export function isFsSendPlatform(): boolean {
  return !!getNativeFileStream()?.getPathForFile;
}

/** 單檔大小檢查：平台能力不足（web；或行動端試圖「發送」>2GB）→ 回 'platform_limit' 讓 UI
 *  顯示「請用 App / 請從桌面發送」提示；>2GB 在官方伺服器未訂閱 → subscription_required。 */
export async function checkSingleFileSize(
  size: number,
  direction: 'send' | 'receive' = 'send',
): Promise<'ok' | 'platform_limit'> {
  if (size <= SINGLE_FILE_IDB_MAX) return 'ok';
  if (direction === 'send' ? !isFsSendPlatform() : !isFsStreamPlatform()) return 'platform_limit';
  await requireSubscription();
  return 'ok';
}

export function getTierDeviceLimit(_tier: Tier): number {
  return 10;
}

/** 螢幕「發送」（投放 cast + 延伸 extend）要訂閱；接收不 gate。
 *  桌面 + 行動共用此判定。回 false → caller 開 UpgradePage，不執行 capture。 */
export function isScreenSendAllowed(): boolean {
  return !billingApplies() || useSubscriptionStore.getState().status.isPro;
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
