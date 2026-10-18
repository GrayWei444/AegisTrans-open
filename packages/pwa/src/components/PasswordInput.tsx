/**
 * PasswordInput — 帶眼睛切換顯示/隱藏的密碼輸入框
 */

import { useState } from 'react';

interface PasswordInputProps {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: 'current-password' | 'new-password';
  required?: boolean;
  minLength?: number;
  className?: string;
}

export function PasswordInput({
  id, value, onChange, placeholder, autoComplete = 'current-password',
  required, minLength, className,
}: PasswordInputProps) {
  const [show, setShow] = useState(false);

  return (
    <div className="relative">
      <input
        id={id}
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={className ?? 'w-full pl-3 pr-10 py-2.5 rounded bg-surface-tertiary border border-[var(--surface-border)] text-sm focus:outline-none focus:border-mist-400'}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        tabIndex={-1}
        aria-label={show ? '隱藏密碼' : '顯示密碼'}
        className="absolute inset-y-0 right-0 px-3 text-on-surface-secondary hover:text-mist-300 flex items-center"
      >
        {show ? (
          // 「眼睛劃掉」icon — 表示「點此會隱藏（目前正顯示）」
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
            <path strokeLinecap="round" strokeLinejoin="round"
                  d="M3 3l18 18M10.58 10.58a2 2 0 002.83 2.83M9.88 4.6A10.94 10.94 0 0112 4.5c4.5 0 8.36 2.62 10.5 7.5a11.04 11.04 0 01-3.06 4.07M6.61 6.61C4.79 7.99 3.32 9.93 2.5 12c2.14 4.88 6 7.5 10.5 7.5 1.66 0 3.23-.36 4.61-1.01" />
          </svg>
        ) : (
          // 「眼睛」icon — 表示「點此會顯示（目前隱藏）」
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
            <path strokeLinecap="round" strokeLinejoin="round"
                  d="M2.5 12C4.64 7.12 8.5 4.5 13 4.5s8.36 2.62 10.5 7.5c-2.14 4.88-6 7.5-10.5 7.5S4.64 16.88 2.5 12z M12 9a3 3 0 100 6 3 3 0 000-6z" />
          </svg>
        )}
      </button>
    </div>
  );
}
