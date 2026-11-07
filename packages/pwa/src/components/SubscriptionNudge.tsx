/**
 * 訂閱提示（2026-11-06 Gray 定：登入後不跳方案頁，像遊戲一樣用橫幅＋紅點提示）
 *
 *   - TrialOfferCard：未訂閱時每次打開 App 跳一張大卡片介紹 App（Gray 11-06）。新用戶可關；試用／訂閱已到期關不掉。
 *   - TrialEndingNotice：試用剩 3 天內、或已關自動續訂的訂閱剩 3 天內 → 打開 App 跳一次提醒（一天一次）。
 *     一般會自動續訂的月訂／年訂不提醒（不然每期都跳）。
 *   - useSubscriptionAttention：快到期時「設定」旁亮小紅點、設定裡「訂閱方案」卡片加紅點與紅框（未訂閱不亮）。
 * 只在官方伺服器（billingApplies）；自架伺服器不收費，什麼都不顯示。
 */
import { useEffect, useState } from 'react';
import { useSubscriptionStore } from '../stores/subscriptionStore';
import { billingApplies } from '../services/tierGate';
import { isIapPlatform, getIapProducts, purchaseTier, restoreIapPurchases, TIER_TO_PRODUCT, type IapProduct } from '../services/iap';
import type { SubscriptionStatus } from '../services/subscription';
import { useLanguage } from '../i18n/context';
import { aegisT } from '../i18n/aegistrans-strings';
import official from '../config/official-server.json';

const NOTICE_DAYS = 3;
const NOTICE_SEEN_KEY = 'aegistrans_sub_notice_day';

/** 該提醒的到期剩幾天；不用提醒 → null */
function endingDays(s: SubscriptionStatus): number | null {
  if (!s.isPro || !s.expiresAt) return null;
  if (!s.isTrial && s.willRenew !== false) return null;
  const days = Math.max(0, Math.ceil((s.expiresAt * 1000 - Date.now()) / 86_400_000));
  return days <= NOTICE_DAYS ? days : null;
}

/** 小紅點：只在「快到期」才亮（Gray 11-06：未訂閱不亮，靠首頁橫幅；時間快到才紅點） */
export function useSubscriptionAttention(): boolean {
  const hydrated = useSubscriptionStore((st) => st.hydrated);
  const status = useSubscriptionStore((st) => st.status);
  if (!hydrated || !billingApplies()) return false;
  return endingDays(status) !== null;
}

type StrKey = Parameters<typeof aegisT>[1];
const FEATURES: StrKey[] = ['card.feature1', 'card.feature2', 'card.feature3', 'card.feature4'];
const PLAN_ORDER = ['pro_monthly', 'pro_yearly', 'pro_lifetime'] as const;
const PLAN_LABEL: Record<(typeof PLAN_ORDER)[number], StrKey> = {
  pro_monthly: 'upgrade.tier.monthly', pro_yearly: 'upgrade.tier.yearly', pro_lifetime: 'upgrade.tier.lifetime',
};

/**
 * 未訂閱卡片（Gray 11-06：大張、介紹 App；到期後關不掉）
 *   - 新用戶（hadSubscription=false）：可關（× / 稍後）。有試用資格 →「免費試用 14 天」＋一鍵開始；
 *     這個 Apple ID 用過試用 → 直接列三個方案附價格；連不到商店 → 重試。
 *   - 試用／訂閱已到期（hadSubscription=true）：關不掉，一定要訂閱或買永久版。依 Apple 規定保留
 *     恢復購買、登出、刪除帳號、價格與自動續訂說明、條款／隱私連結。
 */
export function TrialOfferCard({ onShowPlans, onSignOut }: { onShowPlans: () => void; onSignOut: () => void }) {
  const { language } = useLanguage();
  const t = (k: StrKey) => aegisT(language, k);
  const hydrated = useSubscriptionStore((st) => st.hydrated);
  const status = useSubscriptionStore((st) => st.status);
  const setStatus = useSubscriptionStore((st) => st.setStatus);
  const refresh = useSubscriptionStore((st) => st.refresh);
  const show = hydrated && !status.isPro && billingApplies();
  const expired = show && status.hadSubscription;
  const nativeIap = isIapPlatform();
  const [products, setProducts] = useState<IapProduct[] | null>(null);   // null＝載入中
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!show || !nativeIap) return;
    let cancelled = false;
    setProducts(null);
    setLoadFailed(false);
    getIapProducts()
      .then((ps) => { if (!cancelled) setProducts(ps); })
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [show, nativeIap, reloadKey]);

  if (!show || (!expired && dismissed)) return null;

  const buy = async (tier: (typeof PLAN_ORDER)[number]) => {
    setBusy(tier);
    setError(null);
    try {
      const outcome = await purchaseTier(tier);
      if (outcome.ok) await setStatus(outcome.status);
      else if (outcome.reason === 'pending') setError(t('upgrade.purchasePending'));
      else if (outcome.reason !== 'cancelled') setError(`${t('upgrade.purchaseFailed')}${outcome.error ? `：${outcome.error}` : ''}`);
    } finally {
      setBusy(null);
    }
  };
  const restore = async () => {
    setBusy('restore');
    setError(null);
    try {
      const outcome = await restoreIapPurchases();
      if (outcome.ok) await setStatus(outcome.status);
      else setError(t('upgrade.restoreNone'));
    } finally {
      setBusy(null);
    }
  };

  const monthly = products?.find((p) => p.id === TIER_TO_PRODUCT.pro_monthly) ?? null;
  const trialDays = expired ? undefined : monthly?.freeTrialDays;
  const close = () => setDismissed(true);
  const legal = (
    <>
      <a href={official.links.terms} target="_blank" rel="noopener noreferrer" className="underline">{t('app.termsOfService')}</a>
      {' · '}
      <a href={official.links.privacy} target="_blank" rel="noopener noreferrer" className="underline">{t('app.privacyPolicy')}</a>
    </>
  );
  const primaryBtn = 'w-full px-4 py-3.5 rounded-xl bg-mist-500 hover:bg-mist-400 disabled:opacity-50 text-navy-900 text-lg font-semibold';

  let offer;
  if (!nativeIap) {
    offer = (
      <>
        <p className="text-base font-medium text-on-surface-primary">{t(expired ? 'card.expiredDesktop' : 'banner.desktopTrial')}</p>
        {expired ? (
          <button onClick={() => void refresh()} className={`mt-4 ${primaryBtn}`} data-testid="trial-card-recheck">{t('card.recheck')}</button>
        ) : (
          <button onClick={() => { close(); onShowPlans(); }} className={`mt-4 ${primaryBtn}`} data-testid="trial-card-view-plans">{t('banner.viewPlans')}</button>
        )}
      </>
    );
  } else if (loadFailed) {
    offer = (
      <>
        <p className="text-base text-on-surface-primary" data-testid="trial-card-store-error">{t('card.storeError')}</p>
        <button onClick={() => setReloadKey((k) => k + 1)} className={`mt-4 ${primaryBtn}`} data-testid="trial-card-retry">{t('upgrade.storeRetry')}</button>
      </>
    );
  } else if (products === null) {
    offer = <p className="text-base text-on-surface-secondary py-4" data-testid="trial-card-loading">{t('card.loading')}</p>;
  } else if (monthly && trialDays) {
    offer = (
      <>
        <div className="text-2xl font-bold text-mist-300">{t('banner.trialTitle').replace('{days}', String(trialDays))}</div>
        <div className="mt-1 text-sm text-on-surface-secondary">{t('banner.trialThen').replace('{price}', monthly.displayPrice)}</div>
        <button onClick={() => void buy('pro_monthly')} disabled={busy !== null} className={`mt-4 ${primaryBtn}`} data-testid="trial-card-start">
          {busy === 'pro_monthly' ? t('upgrade.processing') : t('banner.trialStart')}
        </button>
        <button onClick={() => { close(); onShowPlans(); }} className="mt-3 text-sm text-mist-300 hover:text-mist-200 underline" data-testid="trial-card-other-plans">
          {t('banner.otherPlans')}
        </button>
        {/* 審核 3.1.1／3.1.2：試用開始前寫清天數、到期後少什麼、之後收多少，附條款與隱私連結 */}
        <p className="mt-4 text-xs leading-relaxed text-on-surface-tertiary text-left">
          {t('upgrade.trialTerms').replace('{days}', String(trialDays))} {legal}
        </p>
      </>
    );
  } else {
    // 用過試用的新用戶、或已到期：直接列方案附價格（商店回什麼就列什麼）
    const plans = PLAN_ORDER.map((tier) => ({ tier, product: products.find((p) => p.id === TIER_TO_PRODUCT[tier]) }))
      .filter((x): x is { tier: (typeof PLAN_ORDER)[number]; product: IapProduct } => !!x.product);
    offer = (
      <>
        <p className="text-base font-medium text-on-surface-primary" data-testid="trial-card-plans-heading">
          {t(expired ? 'card.expiredBody' : 'card.trialUsed')}
        </p>
        <div className="mt-4 space-y-2">
          {plans.map(({ tier, product }) => (
            <button key={tier} onClick={() => void buy(tier)} disabled={busy !== null}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-mist-500 hover:bg-mist-400 disabled:opacity-50 text-navy-900 font-semibold"
              data-testid={`trial-card-buy-${tier}`}>
              <span>{t(PLAN_LABEL[tier])}</span>
              <span className="font-mono text-right leading-tight">
                {busy === tier ? t('upgrade.processing') : product.freeTrialDays ? (
                  // 商店判定這個帳號還有試用資格 → 照實寫（付款畫面也會顯示試用，兩邊要一致）
                  <span className="flex flex-col">
                    <span>{t('banner.trialTitle').replace('{days}', String(product.freeTrialDays))}</span>
                    <span className="text-xs opacity-80">{t('upgrade.trialThen').replace('{price}', product.displayPrice)}</span>
                  </span>
                ) : product.displayPrice}
              </span>
            </button>
          ))}
        </div>
        <button onClick={() => void restore()} disabled={busy !== null} className="mt-3 text-sm text-mist-300 hover:text-mist-200 underline" data-testid="trial-card-restore">
          {busy === 'restore' ? t('upgrade.restoring') : t('upgrade.restoreBtn')}
        </button>
        <p className="mt-4 text-xs leading-relaxed text-on-surface-tertiary text-left">{t('upgrade.autoRenewNotice')} {legal}</p>
      </>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6" role="dialog" aria-modal="true"
      data-testid="trial-offer-card" data-blocking={expired ? 'true' : 'false'}>
      <div className="relative w-full max-w-lg max-h-full overflow-y-auto rounded-2xl bg-surface-secondary border-2 border-mist-500/60 shadow-2xl">
        {!expired && (
          <button onClick={close} className="absolute top-3 right-4 text-3xl leading-none text-on-surface-secondary hover:text-on-surface-primary"
            aria-label={t('paywall.close')} data-testid="trial-card-close">×</button>
        )}

        {/* App 介紹（Gray 11-06：卡片要明顯、大張、介紹 App） */}
        <div className="px-6 pt-8 pb-5 text-center bg-gradient-to-b from-mist-500/15 to-transparent rounded-t-2xl">
          <img src="/logo-transparent.png" alt="" className="w-20 h-20 mx-auto mb-3" aria-hidden="true" />
          <h2 className="text-2xl font-bold text-on-surface-primary">{expired ? t('card.expiredTitle') : 'AegisTrans'}</h2>
          <p className="mt-1 text-base text-on-surface-secondary">{t('card.tagline')}</p>
        </div>
        <ul className="px-6 space-y-3" data-testid="trial-card-features">
          {FEATURES.map((k) => (
            <li key={k} className="flex items-start gap-3 text-base text-on-surface-primary">
              <span className="mt-0.5 flex-shrink-0 w-6 h-6 rounded-full bg-mist-500/20 text-mist-400 flex items-center justify-center text-sm font-bold" aria-hidden="true">✓</span>
              <span>{t(k)}</span>
            </li>
          ))}
        </ul>

        <div className="mx-4 mt-5 rounded-xl bg-mist-500/10 border border-mist-500/40 px-5 py-5 text-center">
          {offer}
          {error && <div className="mt-3 text-xs text-red-400" role="alert">{error}</div>}
        </div>

        <div className="px-6 py-4 flex justify-center gap-6 text-sm">
          {expired ? (
            <>
              <button onClick={onSignOut} className="text-on-surface-secondary hover:text-on-surface-primary" data-testid="trial-card-signout">{t('app.signOut')}</button>
              <a href={official.links.deleteAccount} target="_blank" rel="noopener noreferrer" className="text-on-surface-tertiary hover:text-on-surface-secondary underline" data-testid="trial-card-delete-account">
                {t('danger.deleteBtn')}
              </a>
            </>
          ) : (
            <button onClick={close} className="text-on-surface-secondary hover:text-on-surface-primary" data-testid="trial-card-later">{t('paywall.cancel')}</button>
          )}
        </div>
      </div>
    </div>
  );
}

export function TrialEndingNotice({ onShowPlans }: { onShowPlans: () => void }) {
  const { language } = useLanguage();
  const t = (k: Parameters<typeof aegisT>[1]) => aegisT(language, k);
  const hydrated = useSubscriptionStore((st) => st.hydrated);
  const status = useSubscriptionStore((st) => st.status);
  const days = hydrated && billingApplies() ? endingDays(status) : null;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (days === null) return;
    const today = new Date().toISOString().slice(0, 10);
    try {
      if (localStorage.getItem(NOTICE_SEEN_KEY) === today) return;
      localStorage.setItem(NOTICE_SEEN_KEY, today);
    } catch { /* 存不了就照樣提醒一次 */ }
    setOpen(true);
  }, [days]);

  if (!open || days === null) return null;
  const plan = t(status.tier === 'pro_yearly' ? 'upgrade.tier.yearly' : 'upgrade.tier.monthly');
  const body = (status.isTrial
    ? t(status.willRenew ? 'notice.trialEnding' : 'notice.trialEndingCancelled')
    : t('notice.subEnding'))
    .replace('{days}', String(days))
    .replace('{plan}', plan);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" role="dialog" aria-modal="true" data-testid="sub-ending-notice">
      <div className="w-full max-w-md rounded-xl bg-surface-secondary border border-[var(--surface-border)] p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-on-surface-primary mb-2">{t(status.isTrial ? 'notice.trialTitle' : 'notice.subTitle')}</h2>
        <p className="text-sm text-on-surface-secondary leading-relaxed mb-5">{body}</p>
        <div className="flex gap-2">
          <button
            onClick={() => { setOpen(false); onShowPlans(); }}
            className="flex-1 px-4 py-2.5 rounded-md bg-mist-500 hover:bg-mist-400 text-navy-900 font-medium"
            data-testid="sub-ending-view"
          >
            {t('notice.view')}
          </button>
          <button
            onClick={() => setOpen(false)}
            className="flex-1 px-4 py-2.5 rounded-md border border-[var(--surface-border)] text-on-surface-primary"
            data-testid="sub-ending-later"
          >
            {t('paywall.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
