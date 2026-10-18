/**
 * DeviceLimitGate — 登入後 register 撞 409 時顯示的全螢幕 gate。
 *
 * 不是 modal，不是 paywall — 它**取代** main app 直到使用者解決上限為止。
 *
 * 行為：
 *   - 列出 user 現有裝置（從 server 拿到的 list）
 *   - 撤銷 → 立刻 retry register → 成功 → onResolved（清掉 gate state）
 *   - 升級 Pro → onUpgrade（開 UpgradePage）
 *   - 取消 → onCancel（signOut）
 *   - 這個 session 綁定的那台（currentDeviceId）標成「本機」：撤銷它＝撤銷正在登入的 session（AegisTrans 審查 G）
 *   - 重試得到明確的撤銷／session 到期 → 說明登入已失效、請重新登入（onCancel），不再顯示籠統的「登入失敗」
 */

import { useState } from 'react';
import { revokeDevice, registerCurrentDevice, type Device } from '../services/auth';
import { useLanguage } from '../i18n/context';
import { aegisT } from '../i18n/aegistrans-strings';

const LOCALE_BY_LANG: Record<string, string> = {
  'zh-TW': 'zh-TW', 'zh-CN': 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR',
};

interface DeviceLimitGateProps {
  email: string;
  jwt: string;
  pubkey: string | null;
  tier: string;
  tierLimit: number;
  devices: Device[];
  /** 這個 session 綁定的那台（伺服器 409 的 current_device_id）；沒有＝null */
  currentDeviceId?: string | null;
  onResolved: () => void;
  onUpgrade: () => void;
  onCancel: () => void;
}

export function DeviceLimitGate({
  email,
  jwt,
  pubkey,
  tierLimit,
  devices: initialDevices,
  currentDeviceId = null,
  onResolved,
  onUpgrade,
  onCancel,
}: DeviceLimitGateProps) {
  const { language } = useLanguage();
  const [devices, setDevices] = useState<Device[]>(initialDevices);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  const handleRevoke = async (deviceId: string) => {
    if (busyId) return;
    setBusyId(deviceId);
    setError(null);
    try {
      const ok = await revokeDevice(deviceId, jwt);
      if (!ok) {
        setError(aegisT(language, 'deviceGate.revokeFailed'));
        return;
      }
      // 撤銷成功 → retry register
      const result = await registerCurrentDevice(jwt, pubkey);
      if (result.ok) {
        onResolved();
        return;
      }
      if (result.reason === 'device_limit_exceeded') {
        // 還超 — 例如 tierLimit > 1，需要再撤一台
        setDevices(result.devices);
        return;
      }
      if (result.reason === 'revoked' || result.reason === 'expired') {
        // 撤銷了本機（這個 session 綁定的那台）或 session 到期：這個登入已失效，重試不會好 → 說明並請重新登入
        setSignedOut(true);
        return;
      }
      setError(aegisT(language, 'deviceGate.loginFailed'));
    } catch {
      setError(aegisT(language, 'deviceGate.networkError'));
    } finally {
      setBusyId(null);
    }
  };

  const fmtTime = (sec: number): string => {
    const d = new Date(sec * 1000);
    return d.toLocaleString(LOCALE_BY_LANG[language] ?? 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="min-h-screen bg-surface-primary text-on-surface-primary flex items-center justify-center p-6">
      <div className="w-full max-w-lg bg-surface-secondary border border-[var(--surface-border)] rounded-xl p-6 space-y-5">
        <div className="text-center">
          <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-2xl">⚠️</div>
          <h2 className="text-xl font-semibold">{aegisT(language, 'deviceGate.title')}</h2>
          <p className="text-xs text-on-surface-tertiary mt-1">{email}</p>
        </div>

        {signedOut ? (
          <div className="space-y-3">
            <p className="text-sm text-on-surface-secondary leading-relaxed" data-testid="gate-signed-out">
              {aegisT(language, 'deviceGate.signedOut')}
            </p>
            <button
              onClick={onCancel}
              className="w-full px-4 py-3 rounded-md bg-surface-tertiary border border-[var(--surface-border)]"
              data-testid="gate-sign-in-again-btn"
            >
              {aegisT(language, 'deviceGate.signInAgain')}
            </button>
          </div>
        ) : (<>
        <p className="text-sm text-on-surface-secondary leading-relaxed">
          {aegisT(language, 'deviceGate.body')
            .replace('{count}', String(devices.length))
            .replace('{limit}', String(tierLimit))}
        </p>

        <div className="space-y-2">
          {devices.map((d) => (
            <div
              key={d.id}
              className="flex items-start gap-3 p-3 rounded-md border border-[var(--surface-border)] bg-surface-tertiary"
              data-testid={`device-row-${d.id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">
                  {d.label}
                  {d.id === currentDeviceId && (
                    <span className="ml-2 text-xs text-amber-300" data-testid={`this-device-${d.id}`}>
                      （{aegisT(language, 'deviceGate.thisDevice')}）
                    </span>
                  )}
                </div>
                <div className="text-xs text-on-surface-tertiary truncate" title={d.user_agent ?? ''}>
                  {d.user_agent ?? ''}
                </div>
                <div className="text-xs text-on-surface-tertiary mt-0.5">
                  {aegisT(language, 'deviceGate.lastSeen')}：{fmtTime(d.last_seen_at)}
                </div>
              </div>
              <button
                onClick={() => handleRevoke(d.id)}
                disabled={busyId !== null}
                className="px-3 py-1.5 rounded text-sm bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-300 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                data-testid={`revoke-${d.id}`}
              >
                {busyId === d.id ? aegisT(language, 'deviceGate.revoking') : aegisT(language, 'deviceGate.revoke')}
              </button>
            </div>
          ))}
        </div>

        {error && (
          <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2 pt-2 border-t border-[var(--surface-border)]">
          <button
            onClick={onUpgrade}
            disabled={busyId !== null}
            className="w-full px-4 py-3 rounded-md bg-mist-500 hover:bg-mist-400 text-navy-900 font-medium disabled:opacity-50"
            data-testid="gate-upgrade-btn"
          >
            {aegisT(language, 'deviceGate.upgrade')}
          </button>
          <button
            onClick={onCancel}
            disabled={busyId !== null}
            className="w-full px-4 py-3 rounded-md text-on-surface-secondary hover:text-on-surface-primary disabled:opacity-50"
            data-testid="gate-cancel-btn"
          >
            {aegisT(language, 'deviceGate.cancel')}
          </button>
        </div>
        </>)}
      </div>
    </div>
  );
}
