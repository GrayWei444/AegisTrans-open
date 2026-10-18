/**
 * IAP Service — iOS StoreKit 2 / Android Google Play Billing 的 TS 包裝 + 後端驗收據。
 *
 * 流程（自家後端驗收據，不依賴第三方）：
 *   1. getIapProducts() → 原生 getProducts → app 顯示 StoreKit 真實在地化價格（不寫死）
 *   2. purchaseTier(tier) → 原生 purchase → 拿簽名交易 jws → POST /subscription/verify
 *      → 後端用 Apple App Store Server API 驗章設 tier → 成功後原生 finishTransaction
 *   3. restoreIapPurchases() → 原生 restore → 逐筆 jws 送後端 verify（恢復購買 / 驗證失敗補救）
 *   4. Transaction.updates（續訂 / 退款）→ 原生 notify → 自動送後端 re-verify
 *
 * 只在 iOS / Android 原生殼可用。web/electron → UpgradePage 走商店導流路徑。
 */

import { registerPlugin, Capacitor } from '@capacitor/core';
import { apiBase } from './apiBase';
import { normalizeStatus, type Tier, type SubscriptionStatus } from './subscription';

const API_BASE = `${apiBase()}/aegistrans/subscription`;
const SESSION_KEY = 'aegistrans_session';

// ===== Product ID ↔ tier（ASC 定案，見 docs/IAP_ASC_SETUP.md / memory project_iap_asc）=====
export const TIER_TO_PRODUCT: Record<Exclude<Tier, 'free'>, string> = {
  pro_monthly: 'com.aegisrd.aegistrans.pro.monthly',
  pro_yearly: 'com.aegisrd.aegistrans.pro.yearly',
  pro_lifetime: 'com.aegisrd.aegistrans.pro.lifetime',
};
export const PRODUCT_TO_TIER: Record<string, Tier> = Object.fromEntries(
  Object.entries(TIER_TO_PRODUCT).map(([tier, pid]) => [pid, tier as Tier]),
);
export const IAP_PRODUCT_IDS = Object.values(TIER_TO_PRODUCT);

// ===== 原生 plugin 介面 =====
export interface IapProduct {
  id: string;
  displayName: string;
  description: string;
  displayPrice: string;      // StoreKit 已在地化的價格字串（直接顯示，如 "NT$60"）
  price: number;
  currencyCode: string;
  type: string;
  subscriptionPeriod?: string;
}
interface PurchaseResult {
  status: 'purchased' | 'cancelled' | 'pending' | 'unknown';
  jws?: string;
  productId?: string;
  transactionId?: string;
  purchaseToken?: string;
  productType?: 'subs' | 'inapp';
}
interface NativeTransaction {
  jws?: string;
  productId: string;
  transactionId: string;
  purchaseToken?: string;
  productType?: 'subs' | 'inapp';
}
interface RestoreResult { transactions: NativeTransaction[]; }
interface TransactionUpdate extends NativeTransaction { revoked?: boolean; status?: string; }

interface IapPlugin {
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  getProducts(opts: { productIds: string[] }): Promise<{ products: IapProduct[] }>;
  purchase(opts: { productId: string; appAccountToken?: string }): Promise<PurchaseResult>;
  restorePurchases(): Promise<RestoreResult>;
  finishTransaction(opts: { transactionId: string }): Promise<void>;
  addListener(
    event: 'transactionUpdate',
    cb: (u: TransactionUpdate) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const Iap = registerPlugin<IapPlugin>('Iap');

// ===== helpers =====
function getJwt(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as { jwt?: string }).jwt ?? null : null;
  } catch {
    return null;
  }
}

function getUserId(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as { user?: { id?: string } }).user?.id ?? null : null;
  } catch {
    return null;
  }
}

/**
 * CR-05：把 user_id 確定性映射成 UUID 當 StoreKit appAccountToken（與後端
 * _expected_app_account_token 同公式：SHA-256(user_id) 前 16 bytes 格式化為標準 UUID）。
 * 購買時帶上 → Apple 原樣回填交易 → 後端比對綁帳號，防交易被別的帳號認領。
 */
async function appAccountTokenFor(userId: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId));
  const b = new Uint8Array(buf).slice(0, 16);
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// normalizeStatus 共用 subscription.ts 的版本（含 Schema B redundant_subscriptions 欄位）。

/** 只有 iOS / Android 原生殼有商店內購。 */
export function isIapPlatform(): boolean {
  const platform = Capacitor.getPlatform();
  return platform === 'ios' || platform === 'android';
}

export async function isIapAvailable(): Promise<boolean> {
  if (!isIapPlatform()) return false;
  try {
    return (await Iap.isAvailable()).available;
  } catch {
    return false;
  }
}

export async function getIapProducts(): Promise<IapProduct[]> {
  if (!isIapPlatform()) return [];
  const { products } = await Iap.getProducts({ productIds: IAP_PRODUCT_IDS });
  return products;
}

// ===== 後端驗收據 =====
export type VerifyResult =
  | { ok: true; status: SubscriptionStatus }
  | { ok: false; error: string };

/** 把 StoreKit 簽名交易（jws）送後端驗章 → 後端設 tier → 回新 status。 */
export async function verifyPurchase(jws: string): Promise<VerifyResult> {
  const jwt = getJwt();
  if (!jwt) return { ok: false, error: '未登入' };
  try {
    const resp = await fetch(`${API_BASE}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
      body: JSON.stringify({ signedTransaction: jws }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return { ok: false, error: `驗證失敗（${resp.status}）${detail.slice(0, 80)}` };
    }
    return { ok: true, status: normalizeStatus(await resp.json()) };
  } catch {
    return { ok: false, error: '網路錯誤' };
  }
}

/** Google purchase token 只能在可信後端呼叫 Android Publisher API 驗證。 */
export async function verifyGooglePurchase(productId: string, purchaseToken: string, productType: 'subs' | 'inapp'): Promise<VerifyResult> {
  const jwt = getJwt();
  if (!jwt) return { ok: false, error: '未登入' };
  try {
    const resp = await fetch(`${API_BASE}/verify-google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
      body: JSON.stringify({ productId, purchaseToken, productType }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return { ok: false, error: `驗證失敗（${resp.status}）${detail.slice(0, 80)}` };
    }
    return { ok: true, status: normalizeStatus(await resp.json()) };
  } catch {
    return { ok: false, error: '網路錯誤' };
  }
}

async function verifyNativeTransaction(tx: NativeTransaction): Promise<VerifyResult> {
  if (Capacitor.getPlatform() === 'android') {
    if (!tx.productId || !tx.purchaseToken || !tx.productType) return { ok: false, error: 'Google purchase data incomplete' };
    return verifyGooglePurchase(tx.productId, tx.purchaseToken, tx.productType);
  }
  if (!tx.jws) return { ok: false, error: 'Apple transaction data incomplete' };
  return verifyPurchase(tx.jws);
}

// ===== 購買 / 恢復 =====
export type PurchaseOutcome =
  | { ok: true; status: SubscriptionStatus }
  | { ok: false; reason: 'cancelled' | 'pending' | 'verify_failed' | 'error'; error?: string };

/** 完整購買流程：StoreKit 購買 → 後端驗章設 tier → finishTransaction。 */
export async function purchaseTier(tier: Exclude<Tier, 'free'>): Promise<PurchaseOutcome> {
  if (!isIapPlatform()) return { ok: false, reason: 'error', error: 'IAP 僅 iOS / Android App 可用' };
  const productId = TIER_TO_PRODUCT[tier];
  try {
    // CR-05：帶 appAccountToken 綁帳號（沒登入 user_id → 不帶，後端會擋）
    const userId = getUserId();
    const appAccountToken = userId ? await appAccountTokenFor(userId) : undefined;
    const res = await Iap.purchase({ productId, appAccountToken });
    if (res.status === 'cancelled') return { ok: false, reason: 'cancelled' };
    if (res.status === 'pending') return { ok: false, reason: 'pending' };
    if (res.status !== 'purchased') {
      return { ok: false, reason: 'error', error: `購買未完成（${res.status}）` };
    }
    const verified = await verifyNativeTransaction({
      jws: res.jws,
      productId: res.productId ?? productId,
      transactionId: res.transactionId ?? '',
      purchaseToken: res.purchaseToken,
      productType: res.productType,
    });
    if (!verified.ok) return { ok: false, reason: 'verify_failed', error: verified.error };
    // 後端確認後才結束交易
    if (res.transactionId) await Iap.finishTransaction({ transactionId: res.transactionId }).catch(() => {});
    return { ok: true, status: verified.status };
  } catch (e) {
    return { ok: false, reason: 'error', error: (e as Error).message };
  }
}

/** 恢復購買：列目前有效權利，逐筆送後端 verify。回最後一個成功的 status。 */
export async function restoreIapPurchases(): Promise<PurchaseOutcome> {
  if (!isIapPlatform()) return { ok: false, reason: 'error', error: 'IAP 僅 iOS / Android App 可用' };
  try {
    const { transactions } = await Iap.restorePurchases();
    if (transactions.length === 0) return { ok: false, reason: 'error', error: '沒有可恢復的購買' };
    let last: SubscriptionStatus | null = null;
    for (const tx of transactions) {
      const v = await verifyNativeTransaction(tx);
      if (v.ok) {
        last = v.status;
        if (tx.transactionId) await Iap.finishTransaction({ transactionId: tx.transactionId }).catch(() => {});
      }
    }
    return last ? { ok: true, status: last } : { ok: false, reason: 'verify_failed' };
  } catch (e) {
    return { ok: false, reason: 'error', error: (e as Error).message };
  }
}

/**
 * 啟動 Transaction.updates 監聽（續訂 / 退款 / 跨裝置）→ 自動 re-verify 重設 tier。
 * App boot 時呼叫一次；回 unsubscribe。
 */
export async function startIapUpdateListener(onChange?: (s: SubscriptionStatus) => void): Promise<() => void> {
  if (!isIapPlatform()) return () => {};
  const handle = await Iap.addListener('transactionUpdate', (u) => {
    void verifyNativeTransaction(u).then((v) => {
      if (!v.ok) return;
      onChange?.(v.status);
      // CR-05：後端驗證成功後才 finish（原生端不再立即 finish 未驗證交易）
      if (u.transactionId) void Iap.finishTransaction({ transactionId: u.transactionId }).catch(() => {});
    });
  });
  return () => { void handle.remove(); };
}
