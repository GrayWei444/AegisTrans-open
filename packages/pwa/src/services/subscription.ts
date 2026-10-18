/**
 * Subscription Service — tier 查詢 + dev mock 升級
 *
 * Backend: {apiBase()}/aegistrans/subscription/*（api/aegistrans_routes.py）
 *   GET  /status          → 拿當前 tier
 *   POST /dev-set-tier    → dev only，直接寫 tier（給 e2e + dogfood）
 *
 * 純 P2P 原則：licenses table 只存 user_id ↔ tier ↔ expires_at，server 不碰實際資料。
 */

import { apiBase } from './apiBase';

const API_BASE = `${apiBase()}/aegistrans/subscription`;
const SESSION_KEY = 'aegistrans_session';

export type Tier = 'free' | 'pro_monthly' | 'pro_yearly' | 'pro_lifetime';

/** Schema B：比目前 entitlement 低階、卻仍在自動扣款的訂閱（跨商店升級後的重疊期）。
 *  Apple → 顯示持續提醒引導使用者手動取消；Google → server 已自動取消，殘留才提醒。 */
export interface RedundantSubscription {
  store: 'apple' | 'google';
  productId: string | null;
  tier: Tier;
  expiresAt: number | null;
}

export interface SubscriptionStatus {
  tier: Tier;
  isPro: boolean;
  source: string | null;        // 'lemonsqueezy' | 'apple' | 'google' | 'dev' | null
  expiresAt: number | null;     // unix sec
  redundantSubscriptions: RedundantSubscription[];
}

export const FREE_TIER_STATUS: SubscriptionStatus = {
  tier: 'free',
  isPro: false,
  source: null,
  expiresAt: null,
  redundantSubscriptions: [],
};

interface SessionShape {
  jwt: string;
  user?: { id?: string };
}

// review (2026-07-22)：**不再持久化 entitlement 到 localStorage**。前輪為了「斷網冷啟動仍顯示 Pro」
// 把完整 status 存進可改寫的 localStorage，並在讀取時直接信任 → 使用者手改成 pro_lifetime 即偽 Pro，
// 且退款後的 lifetime 會被離線快取無限期接受。這是安全回歸。改回「至少」方案（原 P1 reviewer 亦接受）：
// 冷啟斷網 → 保持 Free、hydrated=false，online/下次 gate 再查；不存本機可信 Pro。tier gate 本就是
// 軟性 client 判定（純 P2P 功能，server 權威項如裝置上限仍由後端擋），不靠本機快取硬撐。
export function getUserId(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as SessionShape).user?.id ?? null;
  } catch {
    return null;
  }
}

function getJwt(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as SessionShape).jwt ?? null;
  } catch {
    return null;
  }
}

interface RawStatus {
  tier: string;
  is_pro: boolean;
  source?: string | null;
  expires_at?: number | null;
  redundant_subscriptions?: Array<{
    store: string; product_id?: string | null; tier: string; expires_at?: number | null;
  }>;
}

export function normalizeStatus(raw: RawStatus): SubscriptionStatus {
  const tier = (
    raw.tier === 'pro_monthly' || raw.tier === 'pro_yearly' || raw.tier === 'pro_lifetime'
      ? raw.tier
      : 'free'
  ) as Tier;
  return {
    tier,
    isPro: !!raw.is_pro,
    source: raw.source ?? null,
    expiresAt: raw.expires_at ?? null,
    redundantSubscriptions: (raw.redundant_subscriptions ?? [])
      .filter((r): r is typeof r & { store: 'apple' | 'google' } => r.store === 'apple' || r.store === 'google')
      .map((r) => ({
        store: r.store,
        productId: r.product_id ?? null,
        tier: (r.tier in { pro_monthly: 1, pro_yearly: 1, pro_lifetime: 1 } ? r.tier : 'free') as Tier,
        expiresAt: r.expires_at ?? null,
      })),
  };
}

/**
 * 拉當前 entitlement。
 * 回 `null` = 「這次沒問到權威答案」（斷網 / 逾時 / 5xx / 200 但 body 壞）→ 呼叫端必須保留
 * last-known，**不可降級**（review P1：合法 Pro 用戶不該因暫時性錯誤掉到 Free、失去大檔功能）。
 * 只有伺服器 200 明確回覆（含 tier=free）或未認證（無 JWT / 401 / 403）才是權威答案。
 */
export async function fetchSubscriptionStatus(): Promise<SubscriptionStatus | null> {
  const jwt = getJwt();
  if (!jwt) return FREE_TIER_STATUS;         // 未登入 → 權威 free
  let resp: Response;
  try {
    resp = await fetch(`${API_BASE}/status`, {
      headers: { 'Authorization': `Bearer ${jwt}` },
    });
  } catch {
    return null;                              // 網路層失敗 → 保留 last-known
  }
  if (resp.status === 401 || resp.status === 403) return FREE_TIER_STATUS;  // 未認證 → 權威 free
  if (!resp.ok) return null;                  // 5xx / 後端維護等 → 保留 last-known
  try {
    return normalizeStatus(await resp.json());
  } catch {
    return null;                              // 200 但 body 壞 → 當沒問到
  }
}

/**
 * Dev mode 升級（給 e2e test + dogfood 用）。
 * Production server 會 403（AEGISTRANS_DEV_MODE 預設 0）。
 */
export async function devSetTier(
  tier: Tier,
  expiresInSeconds?: number,
): Promise<{ ok: true; status: SubscriptionStatus } | { ok: false; error: string }> {
  const jwt = getJwt();
  if (!jwt) return { ok: false, error: '未登入' };
  try {
    const resp = await fetch(`${API_BASE}/dev-set-tier`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
      body: JSON.stringify({ tier, expires_in_seconds: expiresInSeconds ?? null }),
    });
    if (resp.status === 403) {
      return { ok: false, error: 'Dev mode 未啟用' };
    }
    if (!resp.ok) {
      return { ok: false, error: `升級失敗（${resp.status}）` };
    }
    return { ok: true, status: normalizeStatus(await resp.json()) };
  } catch {
    return { ok: false, error: '網路錯誤' };
  }
}
