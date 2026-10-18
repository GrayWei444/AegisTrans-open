/**
 * Subscription Store — 當前 tier + AegisTrans 用量
 *
 * UI 用：
 *   const tier = useSubscriptionStore((s) => s.status.tier);
 *   const isPro = useSubscriptionStore((s) => s.status.isPro);
 *   const usage = useSubscriptionStore((s) => s.usage);
 *
 * 在 App.tsx 登入後呼叫 useSubscriptionStore.getState().refresh() 拉一次。
 * 上傳/刪檔後呼叫 refreshUsage() 更新本機用量（不打 API）。
 */

import { create } from 'zustand';
import {
  fetchSubscriptionStatus,
  getUserId,
  type SubscriptionStatus,
  FREE_TIER_STATUS,
} from '../services/subscription';
import { getAegisTransUsage, type AegisTransUsage, getStorageStatus } from '../services/storageEstimate';
import type { TierGateReason, QuotaDetails, DeviceLimitDetails, SingleFileDetails } from '../services/tierGate';

// 免費版 hard cap（與 LemonSqueezy 月訂同一定價）
export const FREE_TIER_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;  // 2 GB

export interface PaywallContext {
  reason: TierGateReason;
  details: QuotaDetails | DeviceLimitDetails | SingleFileDetails;
}

interface SubscriptionState {
  status: SubscriptionStatus;
  usage: AegisTransUsage;
  /** 裝置可用的 effective quota（bytes）：
   *   - free: min(2GB, deviceQuota)
   *   - pro:  deviceQuota（即 navigator.storage.estimate quota）
   */
  effectiveQuota: number;
  /** 是否已從 server 拉過至少一次 status（避免 SSR-style 閃爍） */
  hydrated: boolean;
  loading: boolean;
  error: string | null;
  /** Paywall modal 顯示狀態。non-null 時 PaywallModal 開啟。 */
  paywall: PaywallContext | null;

  /** 從 server 拉 status + 重算 usage + effectiveQuota。登入後 / 升級成功後呼叫。 */
  refresh: () => Promise<void>;
  /** 只更新本機用量（上傳/刪檔後）。不打 API。 */
  refreshUsage: () => Promise<void>;
  /** 直接套一個新的 status（dev-set-tier / webhook 後用，省一次 GET）。 */
  setStatus: (status: SubscriptionStatus) => Promise<void>;
  /** 開啟 paywall（撞牆時呼叫）。 */
  openPaywall: (ctx: PaywallContext) => void;
  /** 關閉 paywall（X / Esc / 點外圍）。 */
  closePaywall: () => void;
  /** 登出時清空。 */
  reset: () => void;
}

async function recomputeEffectiveQuota(isPro: boolean): Promise<number> {
  const dev = await getStorageStatus();
  return isPro ? dev.quota : Math.min(FREE_TIER_QUOTA_BYTES, dev.quota);
}

// review P2：session generation — 每次 reset（登出/換帳號）+1。refresh 開始時捕捉當下 gen + user，
// 完成時若已變（換帳號期間舊請求才回）→ 丟棄結果，不把 A 的 entitlement 寫進 B 的 store。
let sessionGeneration = 0;

export const useSubscriptionStore = create<SubscriptionState>((set, get) => ({
  status: FREE_TIER_STATUS,   // 初始 Free；不從本機快取 hydrate（可偽造，已移除）
  usage: { bytes: 0, fileCount: 0 },
  effectiveQuota: FREE_TIER_QUOTA_BYTES,
  hydrated: false,
  loading: false,
  error: null,
  paywall: null,

  refresh: async () => {
    const gen = sessionGeneration;
    const startUser = getUserId();
    set({ loading: true, error: null });
    try {
      const [fetched, usage] = await Promise.all([
        fetchSubscriptionStatus(),
        getAegisTransUsage(),
      ]);
      // review P2：請求期間換過帳號/登出（gen 或 user 變了）→ 丟棄，別把舊帳號結果套到新 store。
      if (gen !== sessionGeneration || startUser !== getUserId()) return;
      // fetched===null → 這次沒問到權威答案（網路/5xx）→ 保留目前 status，不降級（review P1）；
      // 且 **不設 hydrated=true**，讓 online 事件 / 下次 gate 再查（不再永遠卡斷網當下狀態）。
      if (fetched === null) {
        const status = get().status;
        const effectiveQuota = await recomputeEffectiveQuota(status.isPro);
        set({ status, usage, effectiveQuota, loading: false });
        return;
      }
      const effectiveQuota = await recomputeEffectiveQuota(fetched.isPro);
      set({ status: fetched, usage, effectiveQuota, hydrated: true, loading: false });
    } catch (e) {
      if (gen !== sessionGeneration) return;
      set({ loading: false, error: e instanceof Error ? e.message : 'unknown' });
    }
  },

  refreshUsage: async () => {
    const usage = await getAegisTransUsage();
    set({ usage });
  },

  setStatus: async (status: SubscriptionStatus) => {
    const effectiveQuota = await recomputeEffectiveQuota(status.isPro);
    // 升級成功 → 自動關閉 paywall
    set({
      status,
      effectiveQuota,
      hydrated: true,
      paywall: status.isPro ? null : get().paywall,
    });
  },

  openPaywall: (ctx) => set({ paywall: ctx }),
  closePaywall: () => set({ paywall: null }),

  reset: () => {
    sessionGeneration += 1;  // invalidate 任何進行中的 refresh（review P2）
    set({
      status: FREE_TIER_STATUS,
      usage: { bytes: 0, fileCount: 0 },
      effectiveQuota: FREE_TIER_QUOTA_BYTES,
      hydrated: false,
      loading: false,
      error: null,
      paywall: null,
    });
  },
}));

// review P1：網路恢復事件 → 重新拉 status（斷網冷啟動後 hydrated 停在 false，online 補一次權威查詢）。
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    const s = useSubscriptionStore.getState();
    if (!s.loading) void s.refresh();
  });
}

/** 給非 React code 用（services 裡需要 tier 判定時）。 */
export function getCurrentTierState() {
  return useSubscriptionStore.getState();
}

// ============================================================
// E2E test seam — 暴露 store 給 Playwright（非 production code path）
// CR-06/H-07：只在 dogfood/e2e build 曝露；release build tree-shake。
// ============================================================
import { DEBUG_TOOLS } from '../utils/debugFlags';
if (DEBUG_TOOLS && typeof window !== 'undefined') {
  // @ts-expect-error: 偷塞給 window
  window.__aegisStores = window.__aegisStores ?? {};
  // @ts-expect-error
  window.__aegisStores.subscription = useSubscriptionStore;
}
