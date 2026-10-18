/**
 * SettingsPage — 設定頁
 *
 * 來源：直接抄 AegisTalk packages/pwa/src/pages/SettingsPage.tsx，
 * 結構 / className / 排版完全一致；針對 AegisTrans 做的簡化：
 *   - 帳號區塊：read-only（email + user_id + 公鑰），AegisTrans 沒有 displayName / avatar 編輯
 *   - 移除：黑名單、AegisGuard 防護、換機與恢復、身份備份、聊天匯出、通知權限
 *   - 新增：密碼登入 section（AegisTrans email + password 登入用）
 *   - 已連結裝置：AegisTrans 多裝置 list（取代 AegisTalk「目前裝置」單一列）
 */
import { useState, useEffect, type FormEvent } from 'react';
import { useThemeStore, type ThemeMode } from '../stores/themeStore';
import { PageHeader } from '../components/common';
import { useLanguage } from '../i18n/context';
import { LANGUAGES, LANGUAGE_LABELS } from '../i18n/types';
import { aegisT, type AegisStringKey } from '../i18n/aegistrans-strings';
import type { Language } from '../i18n/types';
import { PasswordInput } from '../components/PasswordInput';
import { Capacitor } from '@capacitor/core';
import type { useAuth } from '../hooks/useAuth';
import { getPublicKeyBase64Sync } from '../services/identity';
import { formatBytes } from '../services/storageEstimate';
import { getOutboxStats } from '../services/p2pSend';
import { useSubscriptionStore, FREE_TIER_QUOTA_BYTES } from '../stores/subscriptionStore';
import { ServerSettings } from '../components/Settings/ServerSettings';
import { getActiveServer } from '../services/serverChoice';

interface SettingsPageProps {
  auth: ReturnType<typeof useAuth>;
  onBack: () => void;
  /** 開啟付費升級頁的 callback。從 App 注入（保持 SettingsPage 不持有 router）。*/
  onShowUpgrade?: () => void;
}

export function SettingsPage({ auth, onBack, onShowUpgrade }: SettingsPageProps) {
  const { mode: themeMode, setMode: setThemeMode } = useThemeStore();
  const { t, language, setLanguage } = useLanguage();

  const [copied, setCopied] = useState(false);

  const publicKeyBase64 = getPublicKeyBase64Sync();

  // 主題選項（AegisTalk 同款）
  const themeOptions: { value: ThemeMode; label: string }[] = [
    { value: 'dark', label: t('settings.themeDark') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'system', label: t('settings.themeSystem') },
  ];

  const handleCopyPublicKey = async () => {
    if (publicKeyBase64) {
      await navigator.clipboard.writeText(publicKeyBase64);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!auth.user) return null;

  return (
    <div className="h-full flex flex-col bg-surface-primary">
      <PageHeader
        title={t('settings.title')}
        onBack={onBack}
        backIcon={
          <svg className="w-5 h-5 text-on-surface-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        }
      />

      <div className="flex-1 overflow-y-auto">
        {/* 帳號資訊區塊（read-only：email + user_id + 公鑰） */}
        <div className="p-4 border-b border-[var(--surface-border)]">
          <h2 className="text-base font-semibold text-on-surface-secondary mb-3">{t('settings.accountInfo')}</h2>

          {/* Email */}
          <div className="mb-4">
            <label className="text-sm text-on-surface-secondary mb-1 block">Email</label>
            <div className="bg-surface-tertiary rounded-lg px-3 py-2">
              <span className="text-on-surface-primary text-base">{auth.user.email}</span>
            </div>
          </div>

          {/* User ID */}
          <div className="mb-4">
            <label className="text-sm text-on-surface-secondary mb-1 block">User ID</label>
            <div className="bg-surface-tertiary rounded-lg px-3 py-2">
              <code className="text-sm text-on-surface-secondary font-mono truncate block">
                {auth.user.id}
              </code>
            </div>
          </div>

          {/* 公鑰 */}
          <div>
            <label className="text-sm text-on-surface-secondary mb-1 block">{t('settings.publicKey')}</label>
            <div
              onClick={handleCopyPublicKey}
              className="flex items-center justify-between bg-surface-tertiary rounded-lg px-3 py-2 cursor-pointer hover:opacity-80 transition-colors"
            >
              <code className="text-sm text-on-surface-secondary font-mono truncate">
                {publicKeyBase64 ? `${publicKeyBase64.slice(0, 20)}...` : t('common.loading')}
              </code>
              <span className="text-sm text-accent ml-2">
                {copied ? t('common.copied') : t('settings.clickToCopy')}
              </span>
            </div>
          </div>
        </div>

        {/* 密碼登入（AegisTrans 自有） */}
        <PasswordSection
          hasPassword={auth.hasPassword}
          onSetPassword={auth.setPassword}
        />

        {/* 訂閱狀態 + 用量 + 待傳佇列（合併原本 StorageSection） */}
        <SubscriptionSection onShowUpgrade={onShowUpgrade} />

        {/* 外觀設定區塊 — 抄 AegisTalk SettingsPage.tsx lines 363-408 一字不差 */}
        <div className="p-4 border-b border-[var(--surface-border)]">
          <h2 className="text-base font-semibold text-on-surface-secondary mb-3">{t('settings.appearance')}</h2>

          <div className="space-y-4">
            {/* 主題模式 */}
            <div>
              <span className="text-on-surface-primary text-base">{t('settings.themeMode')}</span>
              <div className="flex gap-2 mt-2">
                {themeOptions.map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => setThemeMode(value)}
                    className={`flex-1 flex items-center justify-center py-2.5 rounded-lg text-base transition-all ${
                      themeMode === value
                        ? 'bg-mist-500 text-white'
                        : 'bg-surface-tertiary text-on-surface-secondary hover:opacity-80'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* 語言選擇 */}
            <div>
              <span className="text-on-surface-primary text-base">{t('settings.language')}</span>
              <div className="flex gap-2 mt-2">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang}
                    onClick={() => setLanguage(lang)}
                    className={`flex-1 flex items-center justify-center py-2.5 rounded-lg text-base transition-all ${
                      language === lang
                        ? 'bg-mist-500 text-white'
                        : 'bg-surface-tertiary text-on-surface-secondary hover:opacity-80'
                    }`}
                  >
                    {LANGUAGE_LABELS[lang]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 已連結裝置已移到 BottomNav「裝置」tab，這裡不再重複 */}

        {/* 伺服器：官方或自架（換伺服器會登出） */}
        <ServerSettings signedIn />

        {/* 危險區：刪除帳號（GDPR 資料刪除權） */}
        <DangerZoneSection auth={auth} />

        {/* 版本資訊 */}
        <div className="p-4 text-center text-on-surface-tertiary text-xs space-y-1">
          <p>AegisTrans v0.1.0</p>
          <ServerLinksFooter />
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// 危險區：刪除帳號（GDPR 資料刪除權；Phase 1 收尾項目 A）
// ===========================================================================
/** 條款／隱私／支援連結：跟著目前選的伺服器（官方伺服器 = 官方連結；自架伺服器只顯示它在 server-config 提供的） */
function ServerLinksFooter() {
  const { language } = useLanguage();
  const links = getActiveServer().links;
  const items: { href: string; key: AegisStringKey }[] = [];
  if (links.privacy) items.push({ href: links.privacy, key: 'app.privacyPolicy' });
  if (links.terms) items.push({ href: links.terms, key: 'app.termsOfService' });
  if (links.support) items.push({ href: links.support, key: 'app.support' });
  const linkClass = 'underline hover:text-on-surface-secondary';
  return (
    <>
      {items.length > 0 && (
        <p>
          {items.map((item, i) => (
            <span key={item.key}>
              {i > 0 && ' · '}
              <a href={item.href} target="_blank" rel="noopener noreferrer" className={linkClass}>
                {aegisT(language, item.key)}
              </a>
            </span>
          ))}
        </p>
      )}
      {links.deleteAccount && (
        <p>
          <a href={links.deleteAccount} target="_blank" rel="noopener noreferrer" className={linkClass}>
            {aegisT(language, 'app.deleteAccountWeb')}
          </a>
        </p>
      )}
    </>
  );
}

function DangerZoneSection({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const { language } = useLanguage();
  const [submitting, setSubmitting] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const expected = aegisT(language, 'danger.confirmText');

  const handleDelete = async () => {
    if (submitting) return;
    if (confirmText !== expected) return;
    if (!confirm(aegisT(language, 'danger.confirmDialog'))) return;
    setSubmitting(true);
    const ok = await auth.deleteAccount();
    setSubmitting(false);
    if (!ok) {
      alert(aegisT(language, 'danger.deleteFailed'));
    }
  };

  return (
    <div className="p-4 border-b border-[var(--surface-border)]">
      <h2 className="text-sm font-medium text-red-400 mb-2">{aegisT(language, 'danger.title')}</h2>
      <p className="text-sm text-on-surface-tertiary mb-3 leading-relaxed">
        {aegisT(language, 'danger.description')}
      </p>
      <input
        type="text"
        placeholder={aegisT(language, 'danger.confirmPlaceholder')}
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        className="w-full px-3 py-2 bg-surface-tertiary text-on-surface-primary text-base rounded mb-2 border border-[var(--surface-border)] focus:outline-none focus:border-red-400"
      />
      <button
        type="button"
        onClick={handleDelete}
        disabled={submitting || confirmText !== expected}
        className="w-full py-2 bg-red-500/20 hover:bg-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed text-red-400 text-sm rounded transition-colors"
      >
        {submitting ? aegisT(language, 'danger.deleting') : aegisT(language, 'danger.deleteBtn')}
      </button>
    </div>
  );
}

// ===========================================================================
// 密碼登入 section（AegisTrans 自有；用 AegisTalk 同款 p-4 border-b 排版）
// ===========================================================================
interface PasswordSectionProps {
  hasPassword: boolean | null;
  // C-3：改密碼必須帶 current_password；首次設定時 currentPassword 可為 null
  onSetPassword: (password: string, currentPassword: string | null) => Promise<boolean>;
}

function PasswordSection({ hasPassword, onSetPassword }: PasswordSectionProps) {
  const { language } = useLanguage();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (password.length < 8) { setMsg(aegisT(language, 'password.tooShort')); setMsgIsError(true); return; }
    if (password !== confirm) { setMsg(aegisT(language, 'password.mismatch')); setMsgIsError(true); return; }
    // C-3：已有密碼者改密碼必須輸入 current
    if (hasPassword && !currentPassword) {
      setMsg(aegisT(language, 'password.currentRequired'));
      setMsgIsError(true);
      return;
    }
    setSubmitting(true);
    setMsg(null);
    const ok = await onSetPassword(password, hasPassword ? currentPassword : null);
    setSubmitting(false);
    if (ok) {
      setMsg(aegisT(language, hasPassword ? 'password.updated' : 'password.created'));
      setMsgIsError(false);
      setCurrentPassword('');
      setPassword('');
      setConfirm('');
    } else {
      setMsg(aegisT(language, 'password.setupFailed'));
      setMsgIsError(true);
    }
  };

  return (
    <div className="p-4 border-b border-[var(--surface-border)]">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-on-surface-secondary">{aegisT(language, 'password.title')}</h2>
        <span className={`text-xs ${hasPassword ? 'text-green-500' : 'text-on-surface-tertiary'}`}>
          {hasPassword === null
            ? aegisT(language, 'password.checking')
            : hasPassword
              ? aegisT(language, 'password.set')
              : aegisT(language, 'password.notSet')}
        </span>
      </div>
      <p className="text-sm text-on-surface-tertiary mb-3 leading-relaxed">
        {aegisT(language, 'password.hint')}
      </p>
      <form onSubmit={handleSubmit} className="space-y-2">
        {/* C-3：已有密碼者必須輸入目前密碼才能改 */}
        {hasPassword && (
          <PasswordInput
            autoComplete="current-password"
            minLength={8}
            placeholder={aegisT(language, 'password.currentPlaceholder')}
            value={currentPassword}
            onChange={setCurrentPassword}
          />
        )}
        <PasswordInput
          autoComplete="new-password"
          minLength={8}
          placeholder={aegisT(language, hasPassword ? 'password.newPlaceholder' : 'password.setupPlaceholder')}
          value={password}
          onChange={setPassword}
        />
        <PasswordInput
          autoComplete="new-password"
          minLength={8}
          placeholder={aegisT(language, 'password.confirmPlaceholder')}
          value={confirm}
          onChange={setConfirm}
        />
        {msg && (
          <p className={`text-xs ${msgIsError ? 'text-red-400' : 'text-green-500'}`}>
            {msg}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting || !password || !confirm || (!!hasPassword && !currentPassword)}
          className="w-full py-2.5 bg-mist-500 hover:bg-mist-600 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
        >
          {submitting
            ? aegisT(language, 'password.processing')
            : aegisT(language, hasPassword ? 'password.changeBtn' : 'password.setBtn')}
        </button>
      </form>
    </div>
  );
}

// ===========================================================================
// 已連結裝置 section — 已移到 BottomNav「裝置」tab，本 component 保留以防回滾
// ===========================================================================
// @ts-expect-error - kept for potential rollback
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function DevicesSection({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const { t, language } = useLanguage();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    await auth.refreshDevices();
    setRefreshing(false);
  };

  const handleRevoke = async (deviceId: string) => {
    if (!confirm(t('group.confirmLeave') || '確定移除這個裝置嗎？')) return;
    await auth.revokeDevice(deviceId);
  };

  return (
    <div className="p-4 border-b border-[var(--surface-border)]">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-on-surface-secondary">{t('settings.linkedDevices')}</h2>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="text-xs text-accent hover:opacity-80 disabled:opacity-50"
        >
          {refreshing ? aegisT(language, 'settings.refreshing') : aegisT(language, 'settings.refresh')}
        </button>
      </div>

      <div className="space-y-2">
        {auth.devices.length === 0 ? (
          <p className="text-sm text-on-surface-tertiary">{t('common.noData')}</p>
        ) : (
          auth.devices.map((d) => {
            const isMe = d.id === auth.currentDeviceId;
            return (
              <div
                key={d.id}
                className="flex items-center gap-3 p-3 bg-surface-tertiary rounded-lg"
              >
                <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isMe ? 'bg-green-500/20' : 'bg-mist-500/20'
                }`}>
                  <svg className={`w-5 h-5 ${isMe ? 'text-green-500' : 'text-mist-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-on-surface-primary text-base font-medium truncate">{d.label}</p>
                    {isMe && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-mist-500/20 text-mist-400 flex-shrink-0">
                        {t('settings.thisDevice')}
                      </span>
                    )}
                  </div>
                  <p className="text-on-surface-tertiary text-xs">
                    {d.id.slice(0, 8)}
                    {d.last_seen_at && ` · ${new Date(d.last_seen_at).toLocaleString()}`}
                  </p>
                </div>
                {!isMe && (
                  <button
                    onClick={() => handleRevoke(d.id)}
                    className="text-xs text-red-400 hover:text-red-500 px-2 py-1"
                  >
                    {t('common.remove')}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      <p className="text-xs text-on-surface-tertiary px-1 mt-3">
        {t('settings.linkedDevicesDesc')}
      </p>
    </div>
  );
}

// ============================================================
// Subscription + Storage section（取代原本獨立的 StorageSection）
//   - 顯示 tier-aware effective quota（免費 2GB cap / Pro deviceQuota）
//   - 待傳 outbox 統計（純 P2P：sender 本機 buffer 直到 receiver 上線下載）
//   - 單一卡片 = 單一 source of truth，避免「免費版 2GB vs 裝置 10GB」混淆
// ============================================================
interface SubscriptionSectionProps {
  onShowUpgrade?: () => void;
}

function SubscriptionSection({ onShowUpgrade }: SubscriptionSectionProps) {
  const { language } = useLanguage();
  const status = useSubscriptionStore((s) => s.status);
  const usage = useSubscriptionStore((s) => s.usage);
  const effectiveQuota = useSubscriptionStore((s) => s.effectiveQuota);
  const refresh = useSubscriptionStore((s) => s.refresh);
  const refreshUsage = useSubscriptionStore((s) => s.refreshUsage);
  const [outbox, setOutbox] = useState({ totalMessages: 0, peersAwaiting: 0 });

  // 進入頁面時 refresh 一次（status + usage 可能 stale）
  // 之後每 5 秒只 refresh usage + outbox（不打 status API）
  useEffect(() => {
    void refresh();
    void getOutboxStats().then(setOutbox);
    const id = setInterval(() => {
      void refreshUsage();
      void getOutboxStats().then(setOutbox);
    }, 5000);
    return () => clearInterval(id);
  }, [refresh, refreshUsage]);

  const usagePct = effectiveQuota > 0 ? Math.min(100, (usage.bytes / effectiveQuota) * 100) : 0;
  const isFreeAtCap = !status.isPro && usage.bytes >= FREE_TIER_QUOTA_BYTES;

  // 進度條顏色：>=90% 紅、>=70% 黃、其他 mist 主題色
  const barColor =
    usagePct >= 90 ? 'bg-red-500' :
    usagePct >= 70 ? 'bg-amber-500' :
    'bg-mist-500';

  // quota 來源說明：免費版固定 2GB cap；Pro 受裝置實際空間
  const quotaSourceKey: AegisStringKey = status.isPro
    ? 'subscription.quotaSourceDevice'
    : 'subscription.quotaSourceFree';

  return (
    <div className="p-4 border-b border-[var(--surface-border)]" data-testid="subscription-section">
      <h2 className="text-base font-semibold text-on-surface-secondary mb-3">
        {aegisT(language, 'subscription.title')}
      </h2>

      <div className="bg-surface-tertiary rounded-lg px-3 py-3 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-on-surface-secondary">
            {aegisT(language, 'subscription.currentPlan')}
          </span>
          <span
            className="text-sm font-medium text-on-surface-primary"
            data-testid="settings-tier-label"
          >
            {tierShortLabel(language, status.tier)}
            {status.isPro && (
              <span className="ml-2 px-1.5 py-0.5 rounded bg-mist-500/20 text-mist-500 text-xs">
                Pro
              </span>
            )}
          </span>
        </div>

        <div>
          <div className="flex justify-between text-xs text-on-surface-secondary mb-1">
            <span>{aegisT(language, 'subscription.usageLabel')}</span>
            <span data-testid="settings-usage-text" className="font-mono">
              {formatBytes(usage.bytes)} / {formatBytes(effectiveQuota)} ({usagePct.toFixed(1)}%)
            </span>
          </div>
          <div className="w-full bg-surface-secondary rounded-full h-2 overflow-hidden">
            <div
              className={`h-full transition-all ${barColor}`}
              style={{ width: `${usagePct}%` }}
            />
          </div>
          <div className="text-xs text-on-surface-tertiary mt-1.5">
            {aegisT(language, quotaSourceKey)}
          </div>
        </div>

        {/* 待傳檔案 outbox stats（純 P2P：sender 本機 buffer 直到 receiver 上線下載）*/}
        <div className="flex items-center justify-between text-sm pt-2 border-t border-[var(--surface-border)]">
          <span className="text-on-surface-secondary">{aegisT(language, 'storage.outboxPending')}</span>
          <span className="text-on-surface-primary font-mono" data-testid="settings-outbox-stats">
            {outbox.totalMessages} ({outbox.peersAwaiting} peers)
          </span>
        </div>

        {!status.isPro && (
          <button
            onClick={() => onShowUpgrade?.()}
            className={`w-full px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              isFreeAtCap
                ? 'bg-red-500 hover:bg-red-400 text-white'
                : 'bg-mist-500 hover:bg-mist-400 text-navy-900'
            }`}
            data-testid="settings-upgrade-btn"
          >
            {aegisT(language, isFreeAtCap ? 'subscription.upgradeNow' : 'subscription.upgrade')}
          </button>
        )}

        {/* 跨商店升級後的持續提醒（Schema B）：低階訂閱仍在扣款 → 引導取消。
            平台限定不適用 — 這是使用者「自己已付錢的訂閱」的取消提醒，非導購。 */}
        {status.redundantSubscriptions.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-[var(--surface-border)]" data-testid="settings-redundant-subs">
            {status.redundantSubscriptions.map((r) => (
              <div key={`${r.store}-${r.productId ?? r.tier}`} className="rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 space-y-1">
                <p className="text-xs text-amber-400">
                  {aegisT(language, r.store === 'apple' ? 'upgrade.redundantApple' : 'upgrade.redundantGoogle')
                    .replace('{tier}', tierShortLabel(language, r.tier))}
                </p>
                <a
                  href={r.store === 'apple'
                    ? 'https://apps.apple.com/account/subscriptions'
                    : 'https://play.google.com/store/account/subscriptions?package=com.aegisrd.aegistrans'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-xs text-mist-400 hover:text-mist-300"
                >
                  {aegisT(language, r.store === 'apple' ? 'subscription.manageApple' : 'subscription.manageGoogle')}
                </a>
              </div>
            ))}
          </div>
        )}

        {/* 訂閱管理入口依平台顯示：iOS 只給 Apple、Android 只給 Google（商店規範也要求
            不得在 iOS 導流他店）；web/桌面（可能從任一商店買過）兩個都給。 */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs pt-2 border-t border-[var(--surface-border)]">
          {Capacitor.getPlatform() !== 'android' && (
            <a href="https://apps.apple.com/account/subscriptions" target="_blank" rel="noopener noreferrer" className="underline text-mist-400 hover:text-mist-300">
              {aegisT(language, 'subscription.manageApple')}
            </a>
          )}
          {Capacitor.getPlatform() !== 'ios' && (
            <a href="https://play.google.com/store/account/subscriptions?package=com.aegisrd.aegistrans" target="_blank" rel="noopener noreferrer" className="underline text-mist-400 hover:text-mist-300">
              {aegisT(language, 'subscription.manageGoogle')}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function tierShortLabel(lang: Language, tier: string): string {
  switch (tier) {
    case 'free':         return aegisT(lang, 'upgrade.tier.free');
    case 'pro_monthly':  return aegisT(lang, 'upgrade.tier.monthly');
    case 'pro_yearly':   return aegisT(lang, 'upgrade.tier.yearly');
    case 'pro_lifetime': return aegisT(lang, 'upgrade.tier.lifetime');
    default: return tier;
  }
}
