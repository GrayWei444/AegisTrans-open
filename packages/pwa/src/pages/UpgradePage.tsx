/**
 * UpgradePage — 訂閱升級頁
 *
 * 收費策略（決策時間 2026-05-04）：
 *   - PWA 永遠免費（free tier 限制：2GB / 2 裝置）
 *   - 撞牆 → 引導下載 iOS / Android App → 用 StoreKit / Play Billing 內購
 *   - 抽成 15% (Small Biz < $1M/yr) / 30%，但繞過台灣 Stripe Connect 個人 KYC 風險
 *   - License server 統一：iOS 付的、Android 付的，PWA 都認（透過 GET /subscription/status）
 *
 * 為什麼不在 PWA 直接收：
 *   - Stripe 不支援台灣個人直接收單（需 US LLC）
 *   - LemonSqueezy 被 Stripe 收，台灣個人申請可能被拒
 *   - Polar.sh 文件列台灣但 Stripe Connect Express 對台灣個人 payout 沒明確 commit
 *   - Apple Dev $99/yr + Play Console $25 是 **明確** 接受台灣個人的最穩管道
 *
 * Dev mode（`?dev=1` 或 localStorage `aegistrans_dev_mode=1`）會露出 mock
 * checkout 按鈕（呼叫 /subscription/dev-set-tier，需後端 AEGISTRANS_DEV_MODE=1），
 * 給 e2e 測試 + dogfood 用，正式 user 看不到。
 */

import { useState, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { QRCodeSVG } from 'qrcode.react';

/** Apple 經典咬一口蘋果 logo（線條乾淨、走 currentColor） */
function AppleIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}

/** Android 機器人 logo（雙天線 + 雙眼睛 + 圓底身，走 currentColor） */
function AndroidIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.523 15.3414c-.5511 0-.9993-.4486-.9993-1.0001s.4482-1.0001.9993-1.0001c.5511 0 .9993.4486.9993 1.0001s-.4482 1.0001-.9993 1.0001m-11.046 0c-.5511 0-.9993-.4486-.9993-1.0001s.4482-1.0001.9993-1.0001c.5511 0 .9993.4486.9993 1.0001s-.4482 1.0001-.9993 1.0001m11.4045-6.02l1.9973-3.4592a.416.416 0 00-.1521-.5676.416.416 0 00-.5676.1521l-2.0223 3.503C15.5902 8.2439 13.8533 7.8508 12 7.8508c-1.8533 0-3.5902.3931-5.1396 1.0993L4.838 5.4471a.416.416 0 00-.5676-.1521.416.416 0 00-.1521.5676L6.1156 9.3214C2.6892 11.1867.3432 14.6589 0 18.761h24c-.3432-4.1021-2.6892-7.5743-6.1185-9.4396" />
    </svg>
  );
}
import { useSubscriptionStore } from '../stores/subscriptionStore';
import { devSetTier, type Tier } from '../services/subscription';
import {
  isIapPlatform, getIapProducts, purchaseTier, restoreIapPurchases,
  PRODUCT_TO_TIER, type IapProduct,
} from '../services/iap';
import { useLanguage } from '../i18n/context';
import { DEBUG_TOOLS } from '../utils/debugFlags';
import { aegisT, type AegisStringKey } from '../i18n/aegistrans-strings';
import type { Language } from '../i18n/types';
import official from '../config/official-server.json';

// 商店 listing 公開前保持 false，避免 QR／按鈕把使用者導向 404。
const APP_STORE_URL = 'https://apps.apple.com/app/aegistrans/id6777074011';   // App Apple ID (App Store Connect)
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.aegisrd.aegistrans';
const APP_STORE_LIVE = false;
const PLAY_STORE_LIVE = false;
// 付費方案是官方服務的（App Store／Google Play 內購），條款連結固定指向官方
const TERMS_URL = official.links.terms;
const PRIVACY_URL = official.links.privacy;

function isDevMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).has('dev')) return true;
    if (localStorage.getItem('aegistrans_dev_mode') === '1') return true;
  } catch { /* ignore */ }
  return false;
}

interface PlanOption {
  tier: Tier;
  priceNtd: number;
  priceUsd: number;
  /** dev-set-tier 用，null = lifetime */
  expiresInSeconds: number | null;
  badgeKey?: AegisStringKey;
}

const PLANS: PlanOption[] = [
  { tier: 'pro_monthly',  priceNtd: 60,  priceUsd: 1.99,  expiresInSeconds: 30 * 86400 },
  { tier: 'pro_yearly',   priceNtd: 600, priceUsd: 19.99, expiresInSeconds: 365 * 86400, badgeKey: 'upgrade.badgeYearly' },
  { tier: 'pro_lifetime', priceNtd: 1400, priceUsd: 44.99, expiresInSeconds: null,         badgeKey: 'upgrade.badgeLifetime' },
];

// Schema B 重複購買防護：只露「比目前 tier 高階」的選項。訂閱中只開放終身
// （月→年跨升級要走商店訂閱群組/proration 流程，v1 不做）；終身無可升。
const TIER_RANK: Record<Tier, number> = { free: 0, pro_monthly: 1, pro_yearly: 2, pro_lifetime: 3 };

interface UpgradePageProps {
  onClose: () => void;
}

export function UpgradePage({ onClose }: UpgradePageProps) {
  const { language } = useLanguage();
  const status = useSubscriptionStore((s) => s.status);
  const setStatus = useSubscriptionStore((s) => s.setStatus);
  const devMode = useState(isDevMode)[0];

  const [pendingTier, setPendingTier] = useState<Tier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // 訂閱中買終身的兩步確認（不能用 native confirm — 跨平台 UI 統一紀律）
  const [confirmingTier, setConfirmingTier] = useState<Exclude<Tier, 'free'> | null>(null);

  // iOS / Android 原生殼使用各自商店內購；web / electron 顯示下載導流。
  const nativeIap = isIapPlatform();
  const [products, setProducts] = useState<IapProduct[]>([]);
  const [restoring, setRestoring] = useState(false);
  // 商店載入「失敗」（StoreKit/Play 暫時錯）要跟「回空清單」（商品沒配置）分開：前者顯示
  // 錯誤 + 重試（review P2，正式版也要 — 否則使用者看到「尚未開放」既買不了也無從診斷）。
  const [storeLoadFailed, setStoreLoadFailed] = useState(false);
  const [loadingProducts, setLoadingProducts] = useState(false);

  // 只露可升級選項（已 Pro 擋重複購買的前端 gate — 錢在商店端收，攔在按下去之前）
  const upgradePlans = PLANS.filter((p) =>
    TIER_RANK[p.tier] > TIER_RANK[status.tier] && (!status.isPro || p.tier === 'pro_lifetime'));

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!nativeIap) return;
    let cancelled = false;
    setLoadingProducts(true);
    setStoreLoadFailed(false);
    void getIapProducts()
      .then((p) => {
        if (cancelled) return;
        setProducts(p);
        setLoadingProducts(false);
        // DEBUG builds：商品拉到空清單時把原因顯示出來（iOS WebView 沒有遠端 console，
        // 2026-07-20 sandbox 商品抓不到只能瞎猜 → 錯誤浮上 UI 才能診斷）
        if (DEBUG_TOOLS && p.length === 0) setError('[debug] getProducts 回空清單（無錯誤）— StoreKit 找不到商品 ID');
      })
      .catch((e) => {
        if (cancelled) return;
        // 商店暫時失敗（非「回空清單」）→ 標記失敗，正式版也顯示錯誤 + 重試（review P2）。
        setStoreLoadFailed(true);
        setLoadingProducts(false);
        if (DEBUG_TOOLS) setError('[debug] getProducts 失敗：' + (e instanceof Error ? e.message : String(e)));
      });
    return () => { cancelled = true; };
  }, [nativeIap, reloadKey]);

  const handleIapPurchase = async (tier: Exclude<Tier, 'free'>) => {
    setPendingTier(tier);
    setError(null);
    setSuccess(null);
    try {
      const outcome = await purchaseTier(tier);
      if (outcome.ok) {
        await setStatus(outcome.status);
        setSuccess(aegisT(language, 'upgrade.purchaseSuccess').replace('{tier}', tierLabel(language, outcome.status.tier)));
      } else if (outcome.reason === 'cancelled') {
        /* 使用者取消 → 不報錯 */
      } else if (outcome.reason === 'pending') {
        setError(aegisT(language, 'upgrade.purchasePending'));
      } else {
        setError(`${aegisT(language, 'upgrade.purchaseFailed')}${outcome.error ? `：${outcome.error}` : ''}`);
      }
    } finally {
      setPendingTier(null);
    }
  };

  const handleRestore = async () => {
    setRestoring(true);
    setError(null);
    setSuccess(null);
    try {
      const outcome = await restoreIapPurchases();
      if (outcome.ok) {
        await setStatus(outcome.status);
        setSuccess(aegisT(language, 'upgrade.purchaseSuccess').replace('{tier}', tierLabel(language, outcome.status.tier)));
      } else {
        setError(aegisT(language, 'upgrade.restoreNone'));
      }
    } finally {
      setRestoring(false);
    }
  };

  const handleMockCheckout = async (plan: PlanOption) => {
    setPendingTier(plan.tier);
    setError(null);
    setSuccess(null);
    try {
      const result = await devSetTier(plan.tier, plan.expiresInSeconds ?? undefined);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await setStatus(result.status);
      setSuccess(aegisT(language, 'upgrade.mockSuccess').replace('{tier}', tierLabel(language, plan.tier)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown');
    } finally {
      setPendingTier(null);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-5" data-testid="upgrade-page">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-on-surface-primary">
          {aegisT(language, 'upgrade.title')}
        </h1>
        <button
          onClick={onClose}
          className="text-on-surface-secondary hover:text-on-surface-primary"
          data-testid="upgrade-close"
        >
          ✕
        </button>
      </div>

      {/* Pro 後顯示確認 */}
      {status.isPro && (
        <section
          className="rounded-lg bg-mist-500/10 border border-mist-500/30 p-4 text-center space-y-1"
          data-testid="upgrade-current-pro"
        >
          <div className="text-sm text-on-surface-secondary">
            {aegisT(language, 'upgrade.currentTier')}
          </div>
          <div className="text-lg font-semibold text-mist-500" data-testid="current-tier">
            {tierLabel(language, status.tier)} · Pro
          </div>
          {/* 訂閱（月/年）才有可管理的訂閱；賣斷是非消耗型，不顯示。依平台導向對應商店的
              訂閱管理頁（Apple 審核也偏好明顯的取消/管理入口）。 */}
          {(status.tier === 'pro_monthly' || status.tier === 'pro_yearly') && (
            <a
              href={Capacitor.getPlatform() === 'android'
                ? 'https://play.google.com/store/account/subscriptions?package=com.aegisrd.aegistrans'
                : 'https://apps.apple.com/account/subscriptions'}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-2 px-4 py-2 rounded-md bg-surface-tertiary hover:bg-surface-secondary border border-[var(--surface-border)] text-sm text-on-surface-primary"
              data-testid="manage-subscription-btn"
            >
              {aegisT(language, Capacitor.getPlatform() === 'android' ? 'subscription.manageGoogle' : 'subscription.manageApple')}
            </a>
          )}
        </section>
      )}

      {/* 跨商店升級提醒（Schema B）：更高階方案已入手、低階訂閱仍在扣款 → 引導取消。
          Apple 只能使用者手動取消（webhook 收到 cancel 才消失）；Google server 會自動取消，
          殘留代表自動取消失敗 → 引導手動。 */}
      {status.redundantSubscriptions.length > 0 && (
        <section className="space-y-2" data-testid="redundant-subs">
          {status.redundantSubscriptions.map((r) => (
            <div
              key={`${r.store}-${r.productId ?? r.tier}`}
              className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-4 space-y-2"
              data-testid={`redundant-sub-${r.store}`}
            >
              <p className="text-sm text-amber-400">
                {aegisT(language, r.store === 'apple' ? 'upgrade.redundantApple' : 'upgrade.redundantGoogle')
                  .replace('{tier}', tierLabel(language, r.tier))}
              </p>
              <a
                href={r.store === 'apple'
                  ? 'https://apps.apple.com/account/subscriptions'
                  : 'https://play.google.com/store/account/subscriptions?package=com.aegisrd.aegistrans'}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block px-3 py-1.5 rounded-md bg-surface-tertiary hover:bg-surface-secondary border border-[var(--surface-border)] text-sm text-on-surface-primary"
              >
                {aegisT(language, r.store === 'apple' ? 'subscription.manageApple' : 'subscription.manageGoogle')}
              </a>
            </div>
          ))}
        </section>
      )}

      {/* iOS/Android 原生殼：商店真購買（顯示商店回傳的在地化價，不寫死）。
          只露比目前 tier 高階的選項（已 Pro 擋重複購買；訂閱中可升終身）。 */}
      {nativeIap && upgradePlans.some((plan) => products.some((p) => PRODUCT_TO_TIER[p.id] === plan.tier)) && (
        <section className="space-y-3" data-testid="iap-section">
          <h2 className="text-lg font-semibold text-on-surface-primary text-center">
            {aegisT(language, 'upgrade.iapTitle')}
          </h2>
          <div className="space-y-2">
            {upgradePlans.map((plan) => {
              const product = products.find((p) => PRODUCT_TO_TIER[p.id] === plan.tier);
              if (!product) return null;
              const buyTier = plan.tier as Exclude<Tier, 'free'>;
              return (
                <div key={plan.tier} className="space-y-2">
                  <button
                    onClick={() => (status.isPro ? setConfirmingTier(buyTier) : void handleIapPurchase(buyTier))}
                    disabled={pendingTier !== null}
                    className="w-full flex items-center justify-between px-4 py-3 rounded-lg bg-mist-500 hover:bg-mist-400 disabled:opacity-50 text-navy-900 font-medium transition-colors"
                    data-testid={`iap-buy-${plan.tier}`}
                  >
                    <span className="flex items-center gap-2">
                      {tierLabel(language, plan.tier)}
                      {plan.badgeKey && (
                        <span className="px-1.5 py-0.5 rounded bg-navy-900/15 text-[10px]">
                          {aegisT(language, plan.badgeKey)}
                        </span>
                      )}
                    </span>
                    <span className="font-mono">
                      {pendingTier === plan.tier ? aegisT(language, 'upgrade.processing') : product.displayPrice}
                    </span>
                  </button>
                  {/* 訂閱中買終身的兩步確認（含「舊訂閱怎麼辦」說明） */}
                  {confirmingTier === buyTier && (
                    <div
                      className="rounded-lg bg-surface-secondary border border-[var(--surface-border)] p-3 space-y-3"
                      data-testid="upgrade-confirm"
                    >
                      <p className="text-sm text-on-surface-secondary">
                        {aegisT(language, 'upgrade.confirmUpgradeBody')}
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => { setConfirmingTier(null); void handleIapPurchase(buyTier); }}
                          disabled={pendingTier !== null}
                          className="flex-1 px-3 py-2 rounded-md bg-mist-500 hover:bg-mist-400 disabled:opacity-50 text-navy-900 text-sm font-medium"
                          data-testid="upgrade-confirm-yes"
                        >
                          {aegisT(language, 'upgrade.confirmUpgradeYes')}
                        </button>
                        <button
                          onClick={() => setConfirmingTier(null)}
                          className="flex-1 px-3 py-2 rounded-md bg-surface-tertiary hover:bg-surface-secondary border border-[var(--surface-border)] text-sm text-on-surface-primary"
                          data-testid="upgrade-confirm-no"
                        >
                          {aegisT(language, 'upgrade.confirmUpgradeNo')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {!status.isPro && (
            <button
              onClick={handleRestore}
              disabled={restoring || pendingTier !== null}
              className="w-full text-sm text-mist-400 hover:text-mist-300 disabled:opacity-50 py-2"
              data-testid="iap-restore"
            >
              {restoring ? aegisT(language, 'upgrade.restoring') : aegisT(language, 'upgrade.restoreBtn')}
            </button>
          )}
        </section>
      )}

      {/* 商店暫時載入失敗（native）→ 錯誤 + 重試（review P2）。跟「商品未配置」的 coming-soon 區分：
          前者是 StoreKit/Play 暫時錯，使用者能重試；後者才顯示下載導流。 */}
      {!status.isPro && nativeIap && storeLoadFailed && (
        <section className="rounded-lg bg-red-500/10 border border-red-500/30 p-5 text-center space-y-3" data-testid="store-load-error">
          <p className="text-sm text-red-400">{aegisT(language, 'upgrade.storeLoadError')}</p>
          <button
            onClick={() => { setError(null); setReloadKey((k) => k + 1); }}
            disabled={loadingProducts}
            className="px-4 py-2 rounded-md bg-mist-500 hover:bg-mist-400 disabled:opacity-50 text-navy-900 text-sm font-medium"
            data-testid="store-retry"
          >
            {loadingProducts ? aegisT(language, 'upgrade.processing') : aegisT(language, 'upgrade.storeRetry')}
          </button>
        </section>
      )}

      {/* web/electron 或原生商品尚未配置 → 顯示商店狀態／下載導流。native 載入失敗時改上面
          的錯誤區塊，不顯示 coming-soon（review P2）。 */}
      {!status.isPro && !(nativeIap && storeLoadFailed) && (!nativeIap || products.length === 0) && (
        <section className="space-y-3" data-testid="app-cta-section">
          <div className="rounded-lg bg-surface-secondary border border-[var(--surface-border)] p-5">
            <div className="text-center mb-4">
              <h2 className="text-lg font-semibold text-on-surface-primary">
                {aegisT(language, 'upgrade.appOnlyTitle')}
              </h2>
              <p className="text-xs text-on-surface-tertiary mt-1">
                {aegisT(language, 'upgrade.scanQrPrompt')}
              </p>
            </div>

            {/* 平台限定：iOS 原生殼只露 App Store、Android 只露 Google Play（Apple 審核
                不允許 iOS 內導流他店）；web/桌面才雙店並列。 */}
            <div className={`grid gap-3 ${isIapPlatform() ? 'grid-cols-1' : 'grid-cols-2'}`} data-testid="stores-grid">
              {/* iOS QR */}
              {Capacitor.getPlatform() !== 'android' && (
              <div
                className="flex flex-col items-center gap-2 p-3 rounded-md bg-surface-tertiary hover:bg-surface-secondary border border-[var(--surface-border)] transition-colors"
                data-testid="open-app-store"
              >
                {APP_STORE_LIVE ? (
                  <a href={APP_STORE_URL} target="_blank" rel="noopener noreferrer" className="bg-white p-2 rounded">
                    <QRCodeSVG value={APP_STORE_URL} size={120} level="M" />
                  </a>
                ) : <div className="h-[136px] flex items-center text-center text-sm text-on-surface-tertiary">{aegisT(language, 'upgrade.storeComingSoon')}</div>}
                <span className="flex items-center gap-1.5 text-sm font-medium text-on-surface-primary">
                  <AppleIcon className="w-4 h-4" />
                  {aegisT(language, 'upgrade.openAppStore')}
                </span>
              </div>
              )}
              {/* Android QR */}
              {Capacitor.getPlatform() !== 'ios' && (
              <div
                className="flex flex-col items-center gap-2 p-3 rounded-md bg-surface-tertiary hover:bg-surface-secondary border border-[var(--surface-border)] transition-colors"
                data-testid="open-play-store"
              >
                {PLAY_STORE_LIVE ? (
                  <a href={PLAY_STORE_URL} target="_blank" rel="noopener noreferrer" className="bg-white p-2 rounded">
                    <QRCodeSVG value={PLAY_STORE_URL} size={120} level="M" />
                  </a>
                ) : <div className="h-[136px] flex items-center text-center text-sm text-on-surface-tertiary">{aegisT(language, 'upgrade.storeComingSoon')}</div>}
                <span className="flex items-center gap-1.5 text-sm font-medium text-on-surface-primary">
                  <AndroidIcon className="w-4 h-4" />
                  {aegisT(language, 'upgrade.openPlayStore')}
                </span>
              </div>
              )}
            </div>

            <p className="text-xs text-on-surface-tertiary text-center mt-3">
              {aegisT(language, 'upgrade.appOnlyFootnote')} · {aegisT(language, 'upgrade.appOnlyDesc')}
            </p>
          </div>

          {/* 方案說明（不收，純資訊） */}
          <div className="rounded-lg bg-surface-tertiary p-4">
            <h3 className="text-sm font-medium text-on-surface-secondary mb-2">
              {aegisT(language, 'upgrade.plansTitle')}
            </h3>
            <div className="space-y-1.5">
              {PLANS.map((plan) => (
                <div
                  key={plan.tier}
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-2 text-sm"
                  data-testid={`plan-info-${plan.tier}`}
                >
                  <span className="text-on-surface-primary font-medium whitespace-nowrap">
                    {tierLabel(language, plan.tier)}
                  </span>
                  <span>
                    {plan.badgeKey && (
                      <span className="px-1.5 py-0.5 rounded bg-mist-500/20 text-mist-500 text-[10px] whitespace-nowrap">
                        {aegisT(language, plan.badgeKey)}
                      </span>
                    )}
                  </span>
                  <span className="text-on-surface-primary font-mono text-right whitespace-nowrap">
                    NT$ {plan.priceNtd}
                    <span className="text-on-surface-secondary text-xs ml-1">/ ${plan.priceUsd}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="text-xs leading-relaxed text-on-surface-tertiary space-y-2 border-t border-[var(--surface-border)] pt-3">
        <p>{aegisT(language, 'upgrade.autoRenewNotice')}</p>
        <p>
          {aegisT(language, 'upgrade.legalAgreement')}{' '}
          <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" className="underline hover:text-on-surface-secondary">
            {aegisT(language, 'app.termsOfService')}
          </a>
          {' · '}
          <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="underline hover:text-on-surface-secondary">
            {aegisT(language, 'app.privacyPolicy')}
          </a>
        </p>
      </section>

      {/* Dev mode：mock checkout 按鈕（給 e2e + dogfood 用，正式 user 看不到） */}
      {!status.isPro && devMode && (
        <section className="space-y-2 pt-2 border-t border-[var(--surface-border)]" data-testid="dev-mock-section">
          <h3 className="text-xs uppercase tracking-wider text-on-surface-tertiary">
            🧪 Dev Mode — Mock Checkout
          </h3>
          {PLANS.map((plan) => (
            <button
              key={plan.tier}
              onClick={() => handleMockCheckout(plan)}
              disabled={pendingTier !== null}
              className="w-full px-3 py-2 rounded bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-400 text-sm disabled:opacity-50 text-left"
              data-testid={`buy-${plan.tier}`}
            >
              {pendingTier === plan.tier
                ? aegisT(language, 'upgrade.processing')
                : `Mock buy: ${tierLabel(language, plan.tier)} (NT$ ${plan.priceNtd})`}
            </button>
          ))}
          <p className="text-xs text-on-surface-tertiary">
            {aegisT(language, 'upgrade.mockHint')}
          </p>
        </section>
      )}

      {error && (
        <div
          className="rounded-md bg-red-500/15 border border-red-500/30 text-sm text-red-400 px-3 py-2"
          data-testid="upgrade-error"
          role="alert"
        >
          {error}
        </div>
      )}
      {success && (
        <div
          className="rounded-md bg-green-500/15 border border-green-500/30 text-sm text-green-400 px-3 py-2"
          data-testid="upgrade-success"
          role="status"
        >
          {success}
        </div>
      )}
    </div>
  );
}

const TIER_LABEL_KEY: Record<Tier, AegisStringKey> = {
  free:         'upgrade.tier.free',
  pro_monthly:  'upgrade.tier.monthly',
  pro_yearly:   'upgrade.tier.yearly',
  pro_lifetime: 'upgrade.tier.lifetime',
};

function tierLabel(lang: Language, tier: Tier): string {
  return aegisT(lang, TIER_LABEL_KEY[tier]);
}
