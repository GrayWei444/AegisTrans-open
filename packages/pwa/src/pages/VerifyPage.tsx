/**
 * VerifyPage — 點擊 email magic link 那台裝置看到的頁面。
 *
 * C-3 兩階段確認（防 magic link CSRF / login takeover）：
 *
 *   Step 1（自動）：preview 顯示「Linux · Chrome · zh-TW 正在請求登入此帳號」
 *   Step 2（手動）：使用者按「確認登入」才呼叫 confirm；按「不是我」會關掉視窗（token 自動 15min 過期）
 *
 * 之前的 silent verify 流程允許任何人造訪 URL 就把 verified_at 寫上去；
 * 結合 attacker 持有 request_id 就能拿到 victim JWT。新流程強制人類使用者
 * 看到 client_label（裝置描述）後主動放行。
 *
 * 不會自動登入。原裝置會透過 polling 偵測到 verified 並完成登入。
 */

import { useEffect, useState } from 'react';
import { previewMagicToken, confirmMagicToken } from '../services/auth';
import { useLanguage } from '../i18n/context';
import { aegisT, type AegisStringKey } from '../i18n/aegistrans-strings';

type State =
  | { kind: 'loading' }
  | { kind: 'preview'; email: string; client_label: string | null }
  | { kind: 'confirming' }
  | { kind: 'success'; email: string }
  | { kind: 'rejected' }
  | { kind: 'error'; message: string };

export function VerifyPage() {
  const { language } = useLanguage();
  const tr = (key: AegisStringKey) => aegisT(language, key);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('token');
    if (!t) {
      setState({ kind: 'error', message: aegisT(language, 'verify.missingToken') });
      return;
    }
    setToken(t);

    let cancelled = false;
    (async () => {
      const result = await previewMagicToken(t);
      if (cancelled) return;
      if (result.ok) {
        if (result.confirmed) {
          // 已經確認過（重新整理 verify 頁的情況）
          setState({ kind: 'success', email: result.email });
        } else {
          setState({ kind: 'preview', email: result.email, client_label: result.client_label });
        }
      } else {
        setState({ kind: 'error', message: result.error });
      }
    })();
    return () => { cancelled = true; };
    // 只在進頁面時跑一次；語言變了不重新驗證
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConfirm = async () => {
    if (!token) return;
    setState({ kind: 'confirming' });
    const result = await confirmMagicToken(token);
    if (result.ok) {
      setState({ kind: 'success', email: result.email });
    } else {
      setState({ kind: 'error', message: result.error });
    }
  };

  return (
    <div className="min-h-screen bg-surface-primary text-on-surface-primary flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center">
        {state.kind === 'loading' && (
          <>
            <div className="w-12 h-12 mx-auto mb-4 border-4 border-mist-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-on-surface-secondary">{tr('verify.loading')}</p>
          </>
        )}

        {state.kind === 'preview' && (
          <>
            <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-mist-500/15 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                   className="w-10 h-10 text-mist-300">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
              </svg>
            </div>
            <h1 className="text-2xl font-bold mb-3">{tr('verify.title')}</h1>
            <p className="text-on-surface-secondary leading-relaxed mb-2">
              {tr('verify.account')}<span className="font-mono text-mist-300">{state.email}</span>
            </p>
            <div className="bg-surface-tertiary rounded-lg px-4 py-3 my-5">
              <p className="text-xs text-on-surface-tertiary mb-1">{tr('verify.device')}</p>
              <p className="text-sm text-on-surface-primary font-medium break-all">
                {state.client_label ?? tr('verify.unknownDevice')}
              </p>
            </div>
            <p className="text-sm text-on-surface-secondary leading-relaxed mb-6">
              {tr('verify.warnPre')}<strong className="text-red-400">{tr('verify.warnStrong')}</strong>
              {tr('verify.warnPost')}
            </p>
            <div className="space-y-3">
              <button
                onClick={handleConfirm}
                className="w-full py-3 bg-mist-500 hover:bg-mist-600 text-white text-base font-medium rounded-lg transition-colors"
              >
                {tr('verify.confirm')}
              </button>
              <button
                onClick={() => setState({ kind: 'rejected' })}
                className="w-full py-3 bg-surface-tertiary hover:bg-surface-secondary text-on-surface-secondary text-base rounded-lg transition-colors"
              >
                {tr('verify.reject')}
              </button>
            </div>
          </>
        )}

        {state.kind === 'confirming' && (
          <>
            <div className="w-12 h-12 mx-auto mb-4 border-4 border-mist-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-on-surface-secondary">{tr('verify.confirming')}</p>
          </>
        )}

        {state.kind === 'success' && (
          <>
            <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-green-500/20 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
                   className="w-10 h-10 text-green-400">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
              </svg>
            </div>
            <h1 className="text-2xl font-bold mb-3">{tr('verify.successTitle')}</h1>
            <p className="text-on-surface-secondary leading-relaxed mb-2">
              {state.email}
            </p>
            <p className="text-on-surface-secondary leading-relaxed mb-6">
              {tr('verify.successBody1')}<br/>
              {tr('verify.successBody2')}
            </p>
            <p className="text-xs text-on-surface-tertiary">
              {tr('verify.closeHint')}
            </p>
          </>
        )}

        {state.kind === 'rejected' && (
          <>
            <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-yellow-500/20 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                   className="w-10 h-10 text-yellow-400">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
              </svg>
            </div>
            <h1 className="text-2xl font-bold mb-3">{tr('verify.rejectedTitle')}</h1>
            <p className="text-on-surface-secondary leading-relaxed mb-6">
              {tr('verify.rejectedBody1')}<br/>
              {tr('verify.rejectedBody2')}
            </p>
            <p className="text-xs text-on-surface-tertiary">
              {tr('verify.closeHint')}
            </p>
          </>
        )}

        {state.kind === 'error' && (
          <>
            <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-red-500/20 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                   className="w-10 h-10 text-red-400">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </div>
            <h1 className="text-2xl font-bold mb-3">{tr('verify.errorTitle')}</h1>
            <p className="text-on-surface-secondary leading-relaxed mb-6">
              {state.message}
            </p>
            <p className="text-xs text-on-surface-tertiary">
              {tr('verify.errorHint')}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
