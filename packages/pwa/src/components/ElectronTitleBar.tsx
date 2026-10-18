/**
 * ElectronTitleBar — 桌面 Capacitor Electron 殼跨平台一致 chrome
 *
 * Phase 2 §6.3:對應 CLAUDE.md §4「跨平台 app 外觀必須統一」設計紀律。
 *
 * 渲染條件:只在 Capacitor Electron 殼跑(`isElectron() === true`),
 * PWA / iOS / Android 環境一律不 render(component 直接 return null)。
 *
 * 視覺:
 *   - 高度 36px(對齊 Win/Linux titleBarOverlay height + Mac hiddenInset
 *     traffic light 區高度)
 *   - 跨 Mac/Win/Linux 用同一套 React 元素(min/max/close icons + logo)
 *   - Mac 上:左邊預留 80px 留給 traffic light(Apple HIG 強制)+ 右側不放
 *     min/max/close 按鈕(traffic light 已負責);中央顯示 logo + title
 *   - Win/Linux 上:右側放跨平台一致的 min/max/close 按鈕(自畫,不用 OS icon)
 *
 * 拖曳:
 *   - title bar 區設 `-webkit-app-region: drag`,使用者按住可拖動視窗
 *   - 按鈕區設 `-webkit-app-region: no-drag`,允許 click
 *
 * IPC:透過 `window.aegisElectron.*` 走 preload contextBridge 觸發 main process
 * IPC handlers(see [electron/src/setup.ts setupWindowControlIpc])。
 */

import { useEffect, useState } from 'react';
import { isElectron, isElectronMac, electronWindow } from '../utils/electronEnv';
import { useLanguage } from '../i18n/context';
import { aegisT } from '../i18n/aegistrans-strings';

export function ElectronTitleBar() {
  const { language } = useLanguage();
  const [isMaximized, setIsMaximized] = useState(false);

  // 只在 Electron 環境訂閱;非 Electron 環境 listener 是 no-op,但 effect 仍跑(無害)
  useEffect(() => {
    if (!isElectron()) return;
    void electronWindow.isMaximized().then(setIsMaximized);
    return electronWindow.onMaximizedChange(setIsMaximized);
  }, []);

  // ⚠️ Hooks 都跑完後才 early return,符合 Rules of Hooks
  if (!isElectron()) return null;

  const isMac = isElectronMac();

  return (
    <div
      className="flex-shrink-0 flex items-center justify-between bg-surface-secondary border-b border-[var(--surface-border)] select-none"
      style={{
        height: '36px',
        // -webkit-app-region: drag — Electron renderer 專用 CSS,讓使用者按住此區可拖視窗
        WebkitAppRegion: 'drag',
        // Mac 上左側預留 80px 給 traffic light(close/min/max 由 OS 提供)
        paddingLeft: isMac ? '80px' : '12px',
        paddingRight: isMac ? '12px' : '0',
      } as React.CSSProperties}
      data-testid="electron-titlebar"
    >
      {/* 左側 / 中央:logo + 「AegisTrans」title */}
      <div className="flex items-center gap-2 text-on-surface-secondary text-xs font-medium">
        <span aria-hidden="true">📡</span>
        <span>AegisTrans</span>
      </div>

      {/* 右側:Win/Linux 才放 min/max/close 按鈕(Mac traffic light 已負責)*/}
      {!isMac && (
        <div
          className="flex items-stretch h-full"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <TitleBarButton
            onClick={() => void electronWindow.minimize()}
            ariaLabel={aegisT(language, 'titleBar.minimize')}
            data-testid="electron-titlebar-minimize"
          >
            <MinimizeIcon />
          </TitleBarButton>
          <TitleBarButton
            onClick={() => void electronWindow.maximizeToggle()}
            ariaLabel={aegisT(language, isMaximized ? 'titleBar.restore' : 'titleBar.maximize')}
            data-testid="electron-titlebar-maximize"
          >
            {isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
          </TitleBarButton>
          <TitleBarButton
            onClick={() => void electronWindow.close()}
            ariaLabel={aegisT(language, 'titleBar.close')}
            isClose
            data-testid="electron-titlebar-close"
          >
            <CloseIcon />
          </TitleBarButton>
        </div>
      )}
    </div>
  );
}

// ============================================
// Sub-components
// ============================================

interface TitleBarButtonProps {
  onClick: () => void;
  ariaLabel: string;
  isClose?: boolean;
  children: React.ReactNode;
  'data-testid'?: string;
}

function TitleBarButton({ onClick, ariaLabel, isClose, children, ...rest }: TitleBarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={ariaLabel}
      aria-label={ariaLabel}
      className={
        'flex items-center justify-center w-12 h-full transition-colors text-on-surface-secondary ' +
        (isClose
          ? 'hover:bg-red-500 hover:text-white'
          : 'hover:bg-surface-tertiary')
      }
      data-testid={rest['data-testid']}
    >
      {children}
    </button>
  );
}

// 跨平台一致的 SVG icons(自畫,不依賴 OS native icons)
// 10×10 viewBox,2px stroke,跟 Win 11 Fluent 樣式接近但更簡潔

function MinimizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {/* 後置方框(代表「還原時的視窗」)*/}
      <rect x="2.5" y="0.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none" />
      {/* 前置方框(代表「目前已最大化的視窗」)— 用 surface 色蓋住後置方框被遮住的部分 */}
      <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="var(--surface-secondary)" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1" />
      <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
