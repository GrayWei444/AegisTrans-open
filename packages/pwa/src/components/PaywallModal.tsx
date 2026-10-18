/**
 * PaywallModal — 撞牆觸發、引導升級
 *
 * 觸發點：
 *   - sendFile 撞 storage_quota_exceeded
 *   - registerCurrentDevice 撞 device_limit_exceeded
 *
 * 由 useSubscriptionStore.paywall 控制（non-null = 開）。
 * 三個 CTA：升級 / 改另一台裝置（device_limit）/ 清空舊檔（storage_quota）/ 取消
 */

import { useEffect } from 'react';
import { useSubscriptionStore } from '../stores/subscriptionStore';
import { aegisT } from '../i18n/aegistrans-strings';
import { useLanguage } from '../i18n/context';
import { formatBytes } from '../services/storageEstimate';
import type { QuotaDetails, DeviceLimitDetails, SingleFileDetails } from '../services/tierGate';

interface PaywallModalProps {
  onUpgradeClick: () => void;
  onManageDevicesClick: () => void;
}

export function PaywallModal({ onUpgradeClick, onManageDevicesClick }: PaywallModalProps) {
  const { language } = useLanguage();
  const paywall = useSubscriptionStore((s) => s.paywall);
  const closePaywall = useSubscriptionStore((s) => s.closePaywall);

  useEffect(() => {
    if (!paywall) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePaywall(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paywall, closePaywall]);

  if (!paywall) return null;

  const isQuota = paywall.reason === 'storage_quota_exceeded';
  const isFile = paywall.reason === 'single_file_too_large';
  const title = isQuota
    ? aegisT(language, 'paywall.quotaTitle')
    : isFile
      ? aegisT(language, 'paywall.fileTitle')
      : aegisT(language, 'paywall.deviceTitle');

  let body: string;
  if (isFile) {
    const d = paywall.details as SingleFileDetails;
    body = aegisT(language, 'paywall.fileBody')
      .replace('{size}', formatBytes(d.size))
      .replace('{limit}', formatBytes(d.limit));
  } else if (isQuota) {
    const d = paywall.details as QuotaDetails;
    body = aegisT(language, 'paywall.quotaBody')
      .replace('{used}', formatBytes(d.used))
      .replace('{quota}', formatBytes(d.quota))
      .replace('{needed}', formatBytes(d.needed));
  } else {
    const d = paywall.details as DeviceLimitDetails;
    body = aegisT(language, 'paywall.deviceBody')
      .replace('{count}', String(d.deviceCount))
      .replace('{limit}', String(d.tierLimit));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      data-testid="paywall-modal"
      role="dialog"
      aria-modal="true"
      onClick={closePaywall}
    >
      <div
        className="w-full max-w-md rounded-xl bg-surface-secondary border border-[var(--surface-border)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <h2 className="text-xl font-semibold text-on-surface-primary">{title}</h2>
          <button
            onClick={closePaywall}
            className="text-on-surface-secondary hover:text-on-surface-primary text-2xl leading-none -mt-1"
            data-testid="paywall-close"
            aria-label={aegisT(language, 'paywall.close')}
          >
            ×
          </button>
        </div>

        <p
          className="text-sm text-on-surface-secondary leading-relaxed mb-5 whitespace-pre-line"
          data-testid="paywall-body"
        >
          {body}
        </p>

        <div className="flex flex-col gap-2">
          <button
            onClick={() => { closePaywall(); onUpgradeClick(); }}
            className="w-full px-4 py-3 rounded-md bg-mist-500 hover:bg-mist-400 text-navy-900 font-medium"
            data-testid="paywall-upgrade-btn"
          >
            {aegisT(language, 'paywall.upgradeBtn')}
          </button>

          {!isQuota && !isFile && (
            <button
              onClick={() => { closePaywall(); onManageDevicesClick(); }}
              className="w-full px-4 py-3 rounded-md bg-surface-tertiary hover:opacity-90 text-on-surface-primary border border-[var(--surface-border)]"
              data-testid="paywall-manage-devices-btn"
            >
              {aegisT(language, 'paywall.manageDevicesBtn')}
            </button>
          )}

          <button
            onClick={closePaywall}
            className="w-full px-4 py-3 rounded-md text-on-surface-secondary hover:text-on-surface-primary"
            data-testid="paywall-cancel"
          >
            {aegisT(language, 'paywall.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
