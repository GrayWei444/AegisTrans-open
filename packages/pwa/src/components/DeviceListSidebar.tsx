/**
 * DeviceListSidebar — 左側裝置列表（即「我的裝置」群組成員）
 *
 * 仿 AegisTalk FriendList 排版：每個裝置一列，附線上指示。
 * Phase 1 收尾 i18n 全面化 + 字體放大（手機可讀）。
 */

import { useState, useEffect } from 'react';
import type { Device } from '../services/auth';
import type { DevicePresenceMap } from '../hooks/useDevicePresence';
import { useLanguage } from '../i18n/context';
import { aegisT } from '../i18n/aegistrans-strings';
import {
  AegisDisplay,
  type VirtualDisplayStatus,
} from '@aegisrd/capacitor-aegisdisplay';
import { screenShareService } from '../services/screenShare';
import { nativeScreenSenderService } from '../services/nativeScreenSender';
import { isScreenSendAllowed } from '../services/tierGate';
import { CastIcon, ExtendIcon, StopIcon } from './icons/screenIcons';

// Phase 2 §6.2:Electron 殼自家 IPC bridge,renderer 透過 preload 拿到。
// 不存在(PWA / 手機)就 fallback 到 web-only UX。
type AegisElectronApi = {
  platform?: 'darwin' | 'win32' | 'linux';
  openSystemDisplaysSettings?: () => Promise<unknown>;
  getDisplaySourceByName?: (
    name: string
  ) => Promise<{ id: string; name: string; display_id: string } | null>;
  getDisplaySourceByDisplayId?: (
    displayId: string
  ) => Promise<{ id: string; name: string; display_id: string } | null>;
  /** Phase 3 §7.1:Windows-only heuristic (CLI 不回 displayId,找 last secondary display) */
  getVirtualDisplaySource?: () => Promise<{ id: string; name: string; display_id: string } | null>;
  getScreenRecordingStatus?: () => Promise<string>;
  openScreenRecordingSettings?: () => Promise<unknown>;
};
function getAegisElectronApi(): AegisElectronApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { aegisElectron?: AegisElectronApi }).aegisElectron;
}

interface DeviceListSidebarProps {
  devices: Device[];
  currentDeviceId: string | null;
  presence: DevicePresenceMap;
  onRevoke: (deviceId: string) => Promise<boolean>;
  mqttConnected: boolean;
  /**
   * Phase 2 §6.4：「投放螢幕」hover action。
   *
   * 提供時：每個非 self、online、有 pubkey 的裝置 row hover 出現「📺 投放」按鈕。
   * 不提供時：button 不 render（向下相容）。
   *
   * 點擊 → caller 自己處理整條（getDisplayMedia → screenShareService.startSharing）。
   * 失敗 / 取消 caller 在 Promise reject 處理（顯示錯誤 toast 等）。
   */
  onShareScreen?: (peerPubkeyBase64: string) => Promise<void> | void;
  /**
   * Phase B：免費版嘗試「發送」螢幕（投放或延伸）時呼叫 → caller 開 UpgradePage。
   * 投放走 onShareScreen（caller 自己 gate）；延伸是本元件自處理，故額外回呼此 gate。
   */
  onScreenSendBlocked?: () => void;
}

export function DeviceListSidebar({
  devices, currentDeviceId, presence, onRevoke, mqttConnected, onShareScreen, onScreenSendBlocked,
}: DeviceListSidebarProps) {
  const { language } = useLanguage();
  const [revoking, setRevoking] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);  // 正在啟動分享的 device id（防雙擊 + button 顯示 busy 狀態）

  // Phase 2 §6.2:本機虛擬螢幕狀態。Plugin 載入時去 query;不支援的平台 supported=false,
  // 後面 UI 自動 hide 按鈕。預設解析度 2560×1440(高 DPI 延伸最常用)。
  // 錯誤訊息走 console + alert,不另外存 state 避免在 sidebar 擠出錯誤 box。
  const [vdStatus, setVdStatus] = useState<VirtualDisplayStatus | null>(null);
  const [vdBusy, setVdBusy] = useState(false);

  // Phase 2 §6.4:從 screenShareService 訂閱「目前正在投放到哪台 peer」狀態。
  // 用來:
  //   1. 在 active 那台 peer row 的 📺 button 變紅顯示「停投放」
  //   2. 其他 row 的 📺 + 🖥️ button disable(同時只能對 1 台 share/extend)
  //   3. 延伸 mode 時 active row 的 📺 也 disable(已在延伸,不能再啟投放)
  // mode 判定:vdStatus.enabled=true → 'extend',否則 isSharing && peer → 'cast'。
  const [activeSharePeer, setActiveSharePeer] = useState<string | null>(
    (typeof screenShareService.getCurrentPeer === 'function' ? screenShareService.getCurrentPeer() : null)
    ?? nativeScreenSenderService.getCurrentPeer()
  );

  useEffect(() => {
    let cancelled = false;
    AegisDisplay.getVirtualDisplayStatus()
      .then((s) => {
        if (cancelled) return;
        // 用 console.error 不是 console.log:Vite prod build 砍掉 log/warn,
        // 留 error。這條是 phase 2 §6.2 ship 階段的 diag,確認 plugin 真接得到
        // native 還是落回 web fallback,等穩定後可刪。
        // eslint-disable-next-line no-console
        console.error('[VD_DIAG] status:', JSON.stringify(s));
        setVdStatus(s);
      })
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[VD_DIAG] status query failed:', err);
        setVdStatus({ supported: false, enabled: false });
      });

    // 訂閱 share state(主動結束、peer 斷線、ANSWER reject 等都會觸發)。
    // 如果 sharing 結束但 vdStatus.enabled 還 true(extend mode 中對方點關閉),
    // 順手把虛擬螢幕也關掉,不然系統會留一個沒人看的 ghost monitor。
    const unsubShare = screenShareService.onShareStateChange((sharing, peer) => {
      if (cancelled) return;
      setActiveSharePeer(sharing ? peer : null);
      if (!sharing && vdStatus?.enabled) {
        AegisDisplay.disableVirtualDisplay()
          .then((s) => { if (!cancelled) setVdStatus(s); })
          .catch(() => { /* ignore — UI 邏輯只看 peer 不會卡 */ });
      }
    });

    // 行動端原生投放(iOS Broadcast Extension)走 nativeScreenSenderService,不經 screenShareService。
    // 訂閱它的狀態,投放中時 active peer row 才會顯示「停投放」(否則 iPhone 投放後 app 內無撤銷鍵)。
    const unsubNative = nativeScreenSenderService.onStateChange((state, peer) => {
      if (cancelled) return;
      setActiveSharePeer(state === 'ended' || state === 'failed' ? null : peer);
    });

    return () => { cancelled = true; unsubShare(); unsubNative(); };
  }, [vdStatus?.enabled]);

  // active mode 一律由「有 peer」決定。沒 peer = idle,即使 vdStatus.enabled 還沒清
  // (虛擬螢幕本身是 system-level state,UI 不該被它鎖死)。
  const activeShareMode: 'cast' | 'extend' | null =
    activeSharePeer ? (vdStatus?.enabled ? 'extend' : 'cast') : null;

  /**
   * Phase 2 §6.2:延伸螢幕「一條龍」流程 — 點延伸 = Windows PC 變成 Mac 第二螢幕。
   *
   * Enable 流程:
   *   1. 檢查 Screen Recording 權限 → 沒給就開 Privacy & Security 面板 + alert 指引
   *   2. plugin 啟用虛擬螢幕(spawn helper,macOS 建 CGVirtualDisplay)
   *   3. 等 macOS 把虛擬螢幕註冊進 desktopCapturer source list(give 500ms)
   *   4. 透過 main IPC 找 "AegisDisplay" 那個 screen source 的 id
   *   5. getUserMedia + chromeMediaSourceId 抓那個 screen 的 stream
   *   6. screenShareService.startSharing(stream, peerPubkey) → 對方裝置即時看到
   *   7. 打開 Displays 面板給使用者調位置
   *
   * Disable 流程:
   *   stopSharing → disableVirtualDisplay → ARC dealloc CGVirtualDisplay → 系統消失
   */
  const handleVirtualDisplayToggle = async (peerPubkeyBase64: string) => {
    if (vdBusy) return;
    const wasEnabled = vdStatus?.enabled === true;
    // Phase B：延伸 = 螢幕「發送」→ 免費版 gate。停用(disable)永遠放行。
    if (!wasEnabled && !isScreenSendAllowed()) {
      onScreenSendBlocked?.();
      return;
    }
    setVdBusy(true);
    const electron = getAegisElectronApi();
    try {
      if (wasEnabled) {
        // === Disable path ===
        try { await screenShareService.stopSharing(); } catch { /* ignore */ }
        const next = await AegisDisplay.disableVirtualDisplay();
        setVdStatus(next);
        return;
      }

      // === Enable path ===

      // Step 1: Screen Recording 權限 — 沒給就 abort,引導使用者去授權
      if (electron?.getScreenRecordingStatus) {
        const perm = await electron.getScreenRecordingStatus();
        if (perm !== 'granted') {
          // 開 Privacy & Security → Screen Recording 面板
          try { await electron.openScreenRecordingSettings?.(); } catch { /* ignore */ }
          alert(
            '需要「螢幕錄製」權限才能延伸到對方裝置。\n\n' +
            '步驟:\n' +
            '1. 在跳出的 System Settings 找到「AegisTrans」並打勾\n' +
            '2. 系統會要求重啟 app — ⌘Q 完全退出後重新打開\n' +
            '3. 再點一次「延伸螢幕」'
          );
          return;
        }
      }

      // Step 2: 啟用虛擬螢幕
      const vdNext = await AegisDisplay.enableVirtualDisplay({ resolution: '2560x1440' });
      setVdStatus(vdNext);
      if (!vdNext.enabled) {
        alert('啟用虛擬螢幕失敗');
        return;
      }

      // Step 3: 等 OS 把虛擬螢幕註冊進 desktopCapturer
      //   - macOS:CGVirtualDisplay register 是 async,需要 etable wait
      //   - Win:driver 改用 dynamic IddCxMonitorArrival 後 enumeration 是 sync,
      //     get-virtual-display-source 自帶 polling,這 gap 是純浪費 → 跳過
      const platform = electron?.platform;
      if (platform !== 'win32') {
        await new Promise((r) => setTimeout(r, 500));
      }

      // Step 4: 找虛擬螢幕的 desktopCapturer source — 分平台:
      //   Mac: CLI 回 hex CGDirectDisplayID(vdNext.displayId),用 getDisplaySourceByDisplayId 精準 match
      //        (不能 name match — macOS 把 source 命名「螢幕 1/2」localized,不是自訂的 "AegisDisplay")
      //   Win: IddCx driver 沒回 displayId(driver 不知道自己在 display enum 第幾位),用
      //        getVirtualDisplaySource heuristic 找最近加入的 secondary display
      const isWin = electron?.platform === 'win32';
      let source: { id: string; name: string; display_id: string } | null = null;
      if (isWin) {
        if (!electron?.getVirtualDisplaySource) {
          alert('Electron bridge 缺 getVirtualDisplaySource(舊版 .exe?)');
          return;
        }
        source = await electron.getVirtualDisplaySource();
        if (!source) {
          alert(
            '找不到 AegisDisplay 虛擬螢幕的 desktopCapturer source。確認:\n' +
            '1. 設定 → 系統 → 顯示器 有看到 AegisDisplay 螢幕\n' +
            '2. 沒有的話,Driver 沒 enumerate 出來,重裝 AegisTrans setup.exe'
          );
          return;
        }
      } else {
        if (!electron?.getDisplaySourceByDisplayId) {
          alert('Electron bridge 缺 getDisplaySourceByDisplayId(舊版 .app?)');
          return;
        }
        if (!vdNext.displayId) {
          alert('enableVirtualDisplay 沒回傳 displayId,無法定位虛擬螢幕');
          return;
        }
        source = await electron.getDisplaySourceByDisplayId(vdNext.displayId);
        if (!source) {
          alert(
            '找不到虛擬螢幕的 screen source(displayId=' + vdNext.displayId +
            ',macOS 還沒把它註冊進 desktopCapturer?)'
          );
          return;
        }
      }

      // Step 5: 抓 stream(chromeMediaSourceId 鎖定那個 screen,不是預設主螢幕)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          // @ts-expect-error — Chromium legacy desktopCapturer constraints,not in TS lib.dom
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
            maxWidth: 2560,
            maxHeight: 1440,
            maxFrameRate: 30,
          },
        },
      });

      // Step 6: 投放給選定的 peer
      await screenShareService.startSharing(stream, peerPubkeyBase64);

      // Step 7: 打開 Displays 面板,使用者拖虛擬螢幕到主螢幕旁
      try { await electron.openSystemDisplaysSettings?.(); } catch { /* ignore */ }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[DeviceListSidebar] virtual display toggle failed:', err);
      alert(`延伸螢幕操作失敗:${msg}`);
      // 失敗時把已啟用的虛擬螢幕收回去,避免 leak
      if (!wasEnabled) {
        try { await screenShareService.stopSharing(); } catch { /* ignore */ }
        try {
          const cleanup = await AegisDisplay.disableVirtualDisplay();
          setVdStatus(cleanup);
        } catch { /* ignore */ }
      }
    } finally {
      setVdBusy(false);
    }
  };

  const handleRevoke = async (id: string) => {
    if (revoking) return;
    const isMe = id === currentDeviceId;
    const confirmMsg = isMe
      ? aegisT(language, 'devices.revokeSelfConfirm')
      : aegisT(language, 'devices.revokeOtherConfirm');
    if (!confirm(confirmMsg)) return;
    setRevoking(id);
    await onRevoke(id);
    setRevoking(null);
  };

  const handleShare = async (deviceId: string, peerPubkey: string) => {
    if (!onShareScreen || sharing) return;
    setSharing(deviceId);
    try {
      await onShareScreen(peerPubkey);
    } finally {
      setSharing(null);
    }
  };

  /** 停投放(active cast 那台 peer row 的紅按鈕觸發) */
  const handleStopCast = async () => {
    if (sharing) return;
    setSharing('__stop__');
    try {
      // 行動端原生投放 → 停原生(立即 stopScreenSend → extension finishBroadcast,本機即停,
      // 不必等 Mac 關閉 / ICE 斷線偵測)。桌面 → 停 screenShareService。
      if (nativeScreenSenderService.isSending()) {
        await nativeScreenSenderService.stop();
      } else {
        await screenShareService.stopSharing();
      }
    } catch {
      // ignore
    } finally {
      setSharing(null);
    }
  };

  const onlineCount = devices.filter((d) => {
    if (d.id === currentDeviceId) return true;
    return d.pubkey ? presence[d.pubkey] : false;
  }).length;

  return (
    <aside className="w-full sm:w-72 bg-surface-tertiary border-r border-[var(--surface-border)] flex flex-col">
      <div className="px-4 py-3 border-b border-[var(--surface-border)]">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-on-surface-primary">{aegisT(language, 'devices.title')}</h2>
          <span className="text-sm text-on-surface-tertiary">
            {onlineCount} / {devices.length} {aegisT(language, 'devices.online')}
          </span>
        </div>
        <div className="text-sm text-on-surface-tertiary mt-1 flex items-center gap-1.5">
          <span className={`inline-block w-2 h-2 rounded-full ${mqttConnected ? 'bg-green-400' : 'bg-gray-500'}`} />
          {mqttConnected ? aegisT(language, 'devices.syncOnline') : aegisT(language, 'devices.syncOffline')}
        </div>
      </div>

      <ul className="flex-1 overflow-y-auto py-1">
        {devices.length === 0 && (
          <li className="px-4 py-6 text-sm text-on-surface-tertiary text-center">
            {aegisT(language, 'devices.empty')}
          </li>
        )}
        {devices.map((d) => {
          const isMe = d.id === currentDeviceId;
          const isOnline = isMe || (d.pubkey ? !!presence[d.pubkey] : false);
          return (
            <li key={d.id}
                className={`group px-4 py-3 hover:bg-surface-tertiary cursor-default flex items-start gap-3`}>
              <div className="relative flex-shrink-0">
                <div className="w-10 h-10 rounded-full bg-mist-500/20 border border-mist-500/30 flex items-center justify-center text-mist-300 text-base font-medium">
                  {avatarInitial(d.label)}
                </div>
                <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-navy-800 ${isOnline ? 'bg-green-400' : 'bg-gray-500'}`} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-base text-on-surface-primary truncate">{d.label}</span>
                  {isMe && (
                    <span className="text-xs uppercase tracking-wider px-1.5 py-0.5 rounded bg-mist-500/20 text-mist-300 flex-shrink-0">
                      {aegisT(language, 'devices.thisDevice')}
                    </span>
                  )}
                </div>
                <div className="text-sm text-on-surface-tertiary truncate">
                  {isOnline
                    ? (isMe ? aegisT(language, 'devices.inUse') : aegisT(language, 'devices.onlineLabel'))
                    : `${aegisT(language, 'devices.lastSeen')} ${formatRelative(d.last_seen_at, language)}`}
                </div>
                {/* 動作列：投放/延伸/撤銷 放第二行 — 避免 narrow 288px sidebar 把裝置名稱擠成 "W" */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5">
              {/* Phase 2 §6.4：投放螢幕 — peer row 才有(本機不投放給自己)。
                  狀態三段:
                    - active cast 那台 peer row → 紅「🛑 停投放」(handleStopCast)
                    - 其他 row 或正在延伸 → disabled
                    - idle → mist 色「📺 投放」可按 */}
              {onShareScreen && !isMe && d.pubkey && (() => {
                const isThisActiveCast = activeShareMode === 'cast' && activeSharePeer === d.pubkey;
                const isThisActiveExtend = activeShareMode === 'extend' && activeSharePeer === d.pubkey;
                // 別的 row 在 share/extend → 整列 disable
                const blockedByOther = activeShareMode !== null && activeSharePeer !== d.pubkey;
                const castDisabled =
                  !isOnline ||
                  !!sharing ||
                  vdBusy ||
                  isThisActiveExtend ||
                  blockedByOther;
                return (
                  <button
                    type="button"
                    onClick={() => {
                      if (isThisActiveCast) { void handleStopCast(); }
                      else { void handleShare(d.id, d.pubkey as string); }
                    }}
                    disabled={castDisabled && !isThisActiveCast}
                    className={`inline-flex items-center gap-1 text-xs disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap ${
                      isThisActiveCast
                        ? 'text-red-400/80 hover:text-red-300'
                        : 'text-mist-300 hover:text-mist-200'
                    }`}
                    title={
                      isThisActiveCast
                        ? '停止投放到這台裝置'
                        : isThisActiveExtend
                        ? '正在延伸到這台裝置(先停延伸才能改投放)'
                        : blockedByOther
                        ? '另一台裝置正在投放/延伸中'
                        : isOnline
                        ? aegisT(language, 'devices.shareScreenTooltip')
                        : aegisT(language, 'devices.shareScreenOffline')
                    }
                    data-testid={`share-screen-${d.id}`}
                  >
                    {sharing === d.id
                      ? '…'
                      : isThisActiveCast
                      ? <><StopIcon className="w-4 h-4" /> 停投放</>
                      : <><CastIcon className="w-4 h-4" /> {aegisT(language, 'devices.shareScreen')}</>}
                  </button>
                );
              })()}
              {/* Phase 2 §6.2:延伸螢幕 — peer row 才有(本機 = 來源,不在本機上延伸給自己看)。
                  動作是「在本機建虛擬螢幕、自動投放給這個 peer」,所以 trigger 在 peer row 合理。
                  狀態三段(類似投放):
                    - active extend 那台 peer row → 紅「🛑 停延伸」
                    - active cast 那台 peer row → disabled(先停投放才能改延伸)
                    - 別的 row 在 share/extend → disabled */}
              {/* 延伸螢幕只在「本機支援虛擬螢幕」的平台顯示(桌面)。iOS/Android getVirtualDisplayStatus
                  回 supported=false → 隱藏延伸按鈕(行動端只投放、不延伸,見 ROADMAP iOS scope)。*/}
              {!isMe && d.pubkey && vdStatus?.supported && (() => {
                const isThisActiveExtend = activeShareMode === 'extend' && activeSharePeer === d.pubkey;
                const isThisActiveCast = activeShareMode === 'cast' && activeSharePeer === d.pubkey;
                const blockedByOther = activeShareMode !== null && activeSharePeer !== d.pubkey;
                const extendDisabled =
                  !isOnline ||
                  vdBusy ||
                  isThisActiveCast ||
                  blockedByOther;
                return (
                <button
                  type="button"
                  onClick={() => { void handleVirtualDisplayToggle(d.pubkey as string); }}
                  disabled={extendDisabled && !isThisActiveExtend}
                  className={`inline-flex items-center gap-1 text-xs disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap ${
                    isThisActiveExtend
                      ? 'text-red-400/80 hover:text-red-300'
                      : 'text-mist-300 hover:text-mist-200'
                  }`}
                  title={
                    isThisActiveExtend
                      ? `停用延伸螢幕(目前 ${vdStatus?.resolution ?? ''})`
                      : isThisActiveCast
                      ? '正在投放到這台裝置(先停投放才能改延伸)'
                      : blockedByOther
                      ? '另一台裝置正在投放/延伸中'
                      : '在本機建立 2560×1440 虛擬螢幕,拖視窗過去再用「投放螢幕」傳給對方'
                  }
                  data-testid={`virtual-display-toggle-${d.id}`}
                >
                  {vdBusy
                    ? '…'
                    : isThisActiveExtend
                    ? <><StopIcon className="w-4 h-4" /> 停延伸</>
                    : <><ExtendIcon className="w-4 h-4" /> 延伸螢幕</>}
                </button>
                );
              })()}
              <button
                onClick={() => handleRevoke(d.id)}
                disabled={revoking === d.id}
                className="opacity-0 group-hover:opacity-100 text-xs text-red-400/80 hover:text-red-300 disabled:opacity-30 whitespace-nowrap"
                title={aegisT(language, 'devices.revokeTooltip')}
              >
                {revoking === d.id ? '…' : aegisT(language, 'devices.revoke')}
              </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function avatarInitial(label: string): string {
  for (const ch of label) {
    if (ch.trim()) return ch.toUpperCase();
  }
  return '·';
}

function formatRelative(unixSec: number, language: 'zh-TW' | 'zh-CN' | 'en' | 'ja' | 'ko'): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return aegisT(language, 'devices.justNow');
  if (diff < 3600) return `${Math.floor(diff / 60)} ${aegisT(language, 'devices.minutesAgo')}`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ${aegisT(language, 'devices.hoursAgo')}`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} ${aegisT(language, 'devices.daysAgo')}`;
  return new Date(unixSec * 1000).toLocaleDateString(language === 'en' ? 'en-US' : language);
}
