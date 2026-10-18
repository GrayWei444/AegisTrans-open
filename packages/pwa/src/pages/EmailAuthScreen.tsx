/**
 * EmailAuthScreen — 標準三件套登入（2026-06 改）
 *
 * 使用者旅程：
 *   登入：email + 密碼（**唯一**登入方式）
 *   註冊：「還沒有帳號?註冊」→ 寄 email 驗證連結 → 建帳號 → 首次登入強制設密碼
 *   忘記密碼：「忘記密碼?」→ 寄 email 重設連結 → 驗證後設新密碼（不需舊密碼）
 *
 * ⚠️ 拿掉了舊的「Email 連結」免密碼登入 tab：email 連結只用於「註冊」與「忘記密碼」，
 *    不再是一個登入方式。
 */

import { useEffect, useState, type FormEvent } from 'react';
import { PasswordInput } from '../components/PasswordInput';
import { useLanguage } from '../i18n/context';
import { aegisT } from '../i18n/aegistrans-strings';
import { ServerSettings } from '../components/Settings/ServerSettings';

interface EmailAuthScreenProps {
  error: string | null;
  linkRequestedFor: string | null;
  onRequestLink: (email: string) => Promise<boolean>;
  onPasswordLogin: (email: string, password: string) => Promise<boolean>;
  onCancelLinkRequest: () => void;
  onClearError: () => void;
  /** 解鎖情境:預填 email(冷啟動身分鎖住,使用者只需輸密碼)。 */
  defaultEmail?: string;
  /** 解鎖情境:顯示「工作階段已鎖定、重輸密碼解鎖」提示(而非一般登入)。 */
  lockedNotice?: boolean;
}

type Mode = 'login' | 'register' | 'forgot';

/** sessionStorage 旗標：forgot 流程驗證 email 後，App 會跳「設新密碼」overlay。 */
export const PW_RESET_FLAG = 'aegis_pw_reset_mode';

const INPUT_CLS =
  'w-full px-4 py-3 rounded-md bg-surface-tertiary border border-[var(--surface-border)] text-on-surface-primary ' +
  'placeholder-gray-500 focus:outline-none focus:border-mist-400 focus:ring-1 focus:ring-mist-400';

export function EmailAuthScreen({
  error, linkRequestedFor, onRequestLink, onPasswordLogin, onCancelLinkRequest, onClearError,
  defaultEmail, lockedNotice,
}: EmailAuthScreenProps) {
  const { language } = useLanguage();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState(defaultEmail ?? '');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    if (mode === 'login') {
      await onPasswordLogin(email, password);
    } else {
      // register / forgot 都走 email 驗證連結；forgot 設旗標，登入後 App 跳「設新密碼」
      try {
        if (mode === 'forgot') sessionStorage.setItem(PW_RESET_FLAG, '1');
        else sessionStorage.removeItem(PW_RESET_FLAG);
      } catch { /* ignore */ }
      await onRequestLink(email);
    }
    setSubmitting(false);
  };

  const switchMode = (m: Mode) => { onClearError(); setMode(m); };

  // 第二狀態：連結已送出，背景輪詢中
  if (linkRequestedFor) {
    return <WaitingForVerification
      email={linkRequestedFor}
      mode={mode}
      submitting={submitting}
      onResend={async () => { setSubmitting(true); await onRequestLink(linkRequestedFor); setSubmitting(false); }}
      onCancel={() => { onClearError(); onCancelLinkRequest(); }}
    />;
  }

  const cfg = {
    login: { btn: aegisT(language, 'auth.btn.login'), busy: aegisT(language, 'auth.btn.loginBusy') },
    register: { btn: aegisT(language, 'auth.btn.register'), busy: aegisT(language, 'auth.btn.sending') },
    forgot: { btn: aegisT(language, 'auth.btn.forgot'), busy: aegisT(language, 'auth.btn.sending') },
  }[mode];

  const canSubmit = !!email && (mode !== 'login' || password.length >= 8);

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-primary text-on-surface-primary px-6">
      <div className="max-w-md w-full">
      <form onSubmit={handleSubmit} className="w-full">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold mb-2">AegisTrans</h1>
          <p className="text-on-surface-secondary text-sm">
            {mode === 'login' && (lockedNotice ? aegisT(language, 'auth.subtitle.locked') : aegisT(language, 'auth.subtitle.login'))}
            {mode === 'register' && aegisT(language, 'auth.subtitle.register')}
            {mode === 'forgot' && aegisT(language, 'auth.subtitle.forgot')}
          </p>
        </div>

        <label htmlFor="email" className="block text-sm font-medium mb-2">Email</label>
        <input
          id="email" type="email" autoComplete="email" required
          value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com" className={INPUT_CLS}
        />

        {mode === 'login' && (
          <>
            <label htmlFor="password" className="block text-sm font-medium mb-2 mt-3">{aegisT(language, 'auth.passwordLabel')}</label>
            <PasswordInput
              id="password" value={password} onChange={setPassword}
              placeholder={aegisT(language, 'auth.passwordPlaceholder')} autoComplete="current-password" required minLength={8}
              className={'pl-4 pr-11 py-3 ' + INPUT_CLS.replace('px-4 py-3 ', '')}
            />
          </>
        )}

        {error && (
          <div className="mt-3 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">{error}</div>
        )}

        <button
          type="submit" disabled={submitting || !canSubmit}
          className="mt-4 w-full py-3 rounded-md bg-mist-500 hover:bg-mist-400
                     disabled:bg-mist-500/40 disabled:cursor-not-allowed
                     text-navy-900 font-medium transition-colors"
        >
          {submitting ? cfg.busy : cfg.btn}
        </button>

        <div className="mt-6 text-xs text-on-surface-tertiary text-center leading-relaxed space-y-2">
          {mode === 'login' && (
            <>
              <p>{aegisT(language, 'auth.noAccount')}{' '}
                <button type="button" onClick={() => switchMode('register')} className="text-mist-400 hover:text-mist-300 underline">{aegisT(language, 'auth.register')}</button>
              </p>
              <p>
                <button type="button" onClick={() => switchMode('forgot')} className="text-mist-400 hover:text-mist-300 underline">{aegisT(language, 'auth.forgotPassword')}</button>
              </p>
            </>
          )}
          {mode === 'register' && (
            <p>{aegisT(language, 'auth.registerHint')}<br/>{aegisT(language, 'auth.hasAccount')}{' '}
              <button type="button" onClick={() => switchMode('login')} className="text-mist-400 hover:text-mist-300 underline">{aegisT(language, 'auth.btn.login')}</button>
            </p>
          )}
          {mode === 'forgot' && (
            <p>{aegisT(language, 'auth.forgotHint')}<br/>{aegisT(language, 'auth.rememberedQ')}{' '}
              <button type="button" onClick={() => switchMode('login')} className="text-mist-400 hover:text-mist-300 underline">{aegisT(language, 'auth.backToLogin')}</button>
            </p>
          )}
        </div>
      </form>
      {/* 伺服器選擇在表單外（不能巢狀 form）。解鎖情境已有 session，換伺服器會登出 → 要確認 */}
      <ServerSettings compact signedIn={!!lockedNotice} />
      </div>
    </div>
  );
}

interface WaitingProps {
  email: string;
  mode: Mode;
  submitting: boolean;
  onResend: () => Promise<void> | void;
  onCancel: () => void;
}

/** email 連結已寄出，原裝置背景輪詢中。60s 後顯示「沒收到?重寄」。 */
function WaitingForVerification({ email, mode, submitting, onResend, onCancel }: WaitingProps) {
  const { language } = useLanguage();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const showResend = elapsed >= 60;
  const title = mode === 'forgot' ? aegisT(language, 'auth.wait.titleReset') : aegisT(language, 'auth.wait.titleVerify');

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-primary text-on-surface-primary px-6">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 mx-auto mb-6 relative">
          <div className="absolute inset-0 rounded-full border-4 border-mist-500/30" />
          <div className="absolute inset-0 rounded-full border-4 border-mist-500 border-t-transparent animate-spin" />
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               className="w-7 h-7 text-mist-400 absolute inset-0 m-auto">
            <path strokeLinecap="round" strokeLinejoin="round"
                  d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
          </svg>
        </div>
        <h1 className="text-2xl font-bold mb-3">{title}</h1>
        <p className="text-on-surface-secondary mb-2 leading-relaxed">
          {aegisT(language, 'auth.wait.sentTo')}<br/>
          <span className="text-mist-300">{email}</span>
        </p>
        <p className="text-on-surface-tertiary text-sm mb-6 leading-relaxed">
          {aegisT(language, 'auth.wait.afterClick')}<br/>
          <span className="text-mist-300">{aegisT(language, 'auth.wait.autoContinue')}</span>。
        </p>
        <p className="text-xs text-on-surface-tertiary mb-4">
          {showResend ? aegisT(language, 'auth.wait.mayTakeTime') : `${aegisT(language, 'auth.wait.waiting')} ${elapsed}s`}
        </p>
        {showResend && (
          <button onClick={() => { void onResend(); }} disabled={submitting}
                  className="text-mist-400 hover:text-mist-300 text-sm underline disabled:opacity-50">
            {submitting ? aegisT(language, 'auth.wait.resending') : aegisT(language, 'auth.wait.notReceived')}
          </button>
        )}
        <div className="mt-3">
          <button onClick={onCancel}
                  className="text-on-surface-tertiary hover:text-on-surface-secondary text-sm">
            {aegisT(language, 'auth.wait.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
