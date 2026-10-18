/**
 * BottomNav — 手機底部 tab 切換
 * 仿 AegisTalk「好友 / 群組 / 防護」三 tab，調整為 AegisTrans 三 tab：
 *   - 對話：Timeline（訊息流）
 *   - 裝置：「我的裝置」列表
 *   - 設定：帳號/密碼/i18n/theme
 */

import type { ReactNode } from 'react';
import { useLanguage } from '../i18n/context';
import { aegisT } from '../i18n/aegistrans-strings';

export type Tab = 'timeline' | 'devices' | 'settings';

interface BottomNavProps {
  active: Tab;
  onChange: (tab: Tab) => void;
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  testId?: string;
}

function TabButton({ active, onClick, icon, label, testId }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      role="tab"
      data-testid={testId}
      aria-selected={active}
      className={`flex-1 flex flex-col items-center gap-1 py-2.5 transition-colors ${
        active ? 'text-mist-300' : 'text-on-surface-tertiary hover:text-on-surface-primary'
      }`}
    >
      <div className="w-7 h-7 flex items-center justify-center">{icon}</div>
      <span className="text-sm">{label}</span>
    </button>
  );
}

export function BottomNav({ active, onChange }: BottomNavProps) {
  const { language } = useLanguage();
  return (
    <nav role="tablist" aria-label="Main navigation" className="sm:hidden safe-area-bottom border-t border-[var(--surface-border)] bg-surface-secondary flex flex-shrink-0">
      <TabButton
        active={active === 'timeline'}
        onClick={() => onChange('timeline')}
        testId="bottom-nav-timeline"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
          </svg>
        }
        label={aegisT(language, 'bottomNav.timeline')}
      />
      <TabButton
        active={active === 'devices'}
        onClick={() => onChange('devices')}
        testId="bottom-nav-devices"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25"/>
          </svg>
        }
        label={aegisT(language, 'bottomNav.devices')}
      />
      <TabButton
        active={active === 'settings'}
        onClick={() => onChange('settings')}
        testId="bottom-nav-settings"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
          </svg>
        }
        label={aegisT(language, 'bottomNav.settings')}
      />
    </nav>
  );
}
