/**
 * 伺服器選擇：顯示目前連哪台，可改成自架伺服器或改回官方。
 *
 * 用在「設定」頁（已登入）與登入畫面（compact）。流程：輸入 API 網址 → 檢查（向伺服器要
 * /aegistrans/auth/server-config）→ 確認 → switchServer()（斷線、登出、存設定、重新載入）。
 */
import { useState, type FormEvent } from 'react';
import { useLanguage } from '../../i18n/context';
import { aegisT, type AegisStringKey } from '../../i18n/aegistrans-strings';
import {
  discoverServer,
  getActiveServer,
  webHost,
  type CustomServer,
  type DiscoveryResult,
} from '../../services/serverChoice';
import { switchServer } from '../../services/serverSwitch';

interface ServerSettingsProps {
  /** 已登入：切換前要確認（會登出） */
  signedIn: boolean;
  /** 登入畫面用的精簡樣式 */
  compact?: boolean;
}

type FailReason = Extract<DiscoveryResult, { ok: false }>['reason'] | 'save_failed';

export function ServerSettings({ signedIn, compact = false }: ServerSettingsProps) {
  const { language } = useLanguage();
  const active = getActiveServer();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(active.isDefault ? '' : active.apiUrl);
  const [busy, setBusy] = useState<'idle' | 'checking' | 'switching'>('idle');
  const [failure, setFailure] = useState<FailReason | null>(null);
  const [found, setFound] = useState<CustomServer | null>(null);

  const t = (key: AegisStringKey) => aegisT(language, key);
  const activeLabel = active.isDefault
    ? `${t('server.official')} · ${webHost(active.apiUrl) ?? active.apiUrl}`
    : `${t('server.custom')} · ${webHost(active.apiUrl) ?? active.apiUrl}`;

  const handleCheck = async (e: FormEvent) => {
    e.preventDefault();
    if (busy !== 'idle') return;
    setFailure(null);
    setFound(null);
    setBusy('checking');
    const result = await discoverServer(url);
    setBusy('idle');
    if (result.ok) setFound(result.server);
    else setFailure(result.reason);
  };

  const doSwitch = async (next: CustomServer | null) => {
    if (busy !== 'idle') return;
    if (signedIn && !confirm(t('server.confirmSignOut'))) return;
    setBusy('switching');
    try {
      await switchServer(next);
    } catch {
      setBusy('idle');
      setFailure('save_failed');
    }
  };

  const wrapper = compact ? 'mt-6 text-sm' : 'p-4 border-b border-[var(--surface-border)]';

  return (
    <div className={wrapper}>
      {!compact && <h2 className="text-base font-semibold text-on-surface-secondary mb-3">{t('server.title')}</h2>}

      <div className="flex items-center justify-between gap-2">
        <span className="text-on-surface-secondary truncate">
          {t('server.current')}: <span className="text-on-surface-primary">{activeLabel}</span>
        </span>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-accent hover:opacity-80 shrink-0"
          >
            {t('server.change')}
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-3 space-y-2">
          <form onSubmit={handleCheck} className="space-y-2">
            <label className="text-sm text-on-surface-secondary block" htmlFor="aegistrans-server-url">
              {t('server.urlLabel')}
            </label>
            <input
              id="aegistrans-server-url"
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setFound(null); setFailure(null); }}
              className="w-full px-3 py-2 bg-surface-tertiary text-on-surface-primary text-base rounded border border-[var(--surface-border)] focus:outline-none focus:border-accent"
            />
            <p className="text-xs text-on-surface-tertiary leading-relaxed">{t('server.urlHint')}</p>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy !== 'idle' || url.trim() === ''}
                className="flex-1 py-2 rounded bg-surface-tertiary text-on-surface-primary disabled:opacity-50"
              >
                {busy === 'checking' ? t('server.checking') : t('server.check')}
              </button>
              <button
                type="button"
                onClick={() => { setEditing(false); setFound(null); setFailure(null); }}
                disabled={busy === 'switching'}
                className="flex-1 py-2 rounded bg-surface-tertiary text-on-surface-secondary disabled:opacity-50"
              >
                {t('server.cancel')}
              </button>
            </div>
          </form>

          {failure && (
            <p className="text-sm text-red-400" role="alert">
              {t(`server.err.${failure}` as AegisStringKey)}
            </p>
          )}

          {found && (
            <div className="rounded bg-surface-tertiary p-3 space-y-2">
              <p className="text-on-surface-primary">
                {t('server.found')}: {found.name ?? webHost(found.apiUrl)}
              </p>
              <p className="text-xs text-on-surface-tertiary break-all">MQTT: {found.mqttUrl}</p>
              <button
                type="button"
                onClick={() => doSwitch(found)}
                disabled={busy !== 'idle'}
                className="w-full py-2 rounded bg-mist-500 text-white disabled:opacity-50"
              >
                {busy === 'switching' ? t('server.switching') : t('server.switch')}
              </button>
            </div>
          )}

          {!active.isDefault && (
            <button
              type="button"
              onClick={() => doSwitch(null)}
              disabled={busy !== 'idle'}
              className="w-full py-2 rounded bg-surface-tertiary text-on-surface-secondary disabled:opacity-50"
            >
              {busy === 'switching' ? t('server.switching') : t('server.useOfficial')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
