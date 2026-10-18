/**
 * RemoteScreenViewer — Phase 2 §6.5 接收端螢幕分享 viewer
 *
 * 三種畫面狀態：
 *   1. 收到 SCREEN_SHARE_OFFER → 跳「接受 / 拒絕」對話框（覆蓋全螢幕中央）
 *   2. 接受後等 stream → 顯示「等待 stream...」過渡狀態
 *   3. stream 抵達 → 全螢幕 video + 控制列（關閉 / 瀏覽器全螢幕）
 *
 * 訂閱：
 *   - screenShareService.onIncomingOffer：接到 sender 的 SDP offer 時
 *   - mediaChannelService.onRemoteStream：實際 stream 抵達時
 *   - mediaChannelService.onRemoteStreamEnded：stream 結束時自動關閉
 *
 * 沿用既有 AegisTrans UI tokens（bg-surface-primary / mist-500 / aegisT i18n）。
 */

import { useEffect, useRef, useState } from 'react';
import { mediaChannelService } from '../services/mediaChannel';
import { screenShareService, type PendingIncomingOffer } from '../services/screenShare';
import { useLanguage } from '../i18n/context';
import { aegisT } from '../i18n/aegistrans-strings';
import type { Device } from '../services/auth';

interface ActiveStream {
  peerPubkey: string;
  stream: MediaStream;
  startedAt: number;
}

interface Props {
  /** 用來把 peer pubkey 對應到 device label（顯示「Linux · Chrome · zh-TW」而不是 raw pubkey） */
  devices: Device[];
}

export function RemoteScreenViewer({ devices }: Props) {
  const { language } = useLanguage();
  const [pending, setPending] = useState<PendingIncomingOffer | null>(null);
  const [active, setActive] = useState<ActiveStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // 訂閱 incoming offer（accept/reject 對話框）
  useEffect(() => {
    return screenShareService.onIncomingOffer((offer) => setPending(offer));
  }, []);

  // 訂閱 remote stream
  useEffect(() => {
    const unsubArrived = mediaChannelService.onRemoteStream((peerPk, stream) => {
      setActive((prev) => {
        if (prev && prev.peerPubkey !== peerPk) return prev;  // 已有別 peer 在分享 → 拒絕新的
        return { peerPubkey: peerPk, stream, startedAt: Date.now() };
      });
    });
    const unsubEnded = mediaChannelService.onRemoteStreamEnded((peerPk) => {
      setActive((prev) => (prev && prev.peerPubkey === peerPk ? null : prev));
    });
    return () => {
      unsubArrived();
      unsubEnded();
    };
  }, []);

  // attach stream → video element
  useEffect(() => {
    const video = videoRef.current;
    if (video && active) {
      video.srcObject = active.stream;
      video.play().catch(() => { /* autoplay 限制；user 互動後手動 play */ });
    }
    return () => {
      if (video) video.srcObject = null;
    };
  }, [active]);

  // ESC 關閉全螢幕
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActive(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  // 解 peer pubkey → device label
  const labelFor = (peerPubkey: string): string => {
    const dev = devices.find((d) => d.pubkey === peerPubkey);
    return dev?.label || peerPubkey.slice(0, 12) + '…';
  };

  // ============================================
  // (1) Accept / Reject 對話框
  // ============================================
  if (pending && !active) {
    const senderLabel = labelFor(pending.peerPubkeyBase64);
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        data-testid="screen-share-incoming-dialog"
      >
        <div className="w-full max-w-md rounded-lg bg-surface-secondary border border-[var(--surface-border)] shadow-2xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full bg-mist-500/20 border border-mist-500/30 flex items-center justify-center text-2xl">
              📺
            </div>
            <div>
              <h2 className="text-lg font-semibold text-on-surface-primary">
                {aegisT(language, 'screenShare.incomingTitle')}
              </h2>
              <p className="text-sm text-on-surface-tertiary mt-0.5">
                {aegisT(language, 'screenShare.fromDevice')} <span className="text-on-surface-primary">{senderLabel}</span>
              </p>
            </div>
          </div>
          <div className="flex gap-2 mt-6">
            <button
              type="button"
              onClick={() => screenShareService.rejectIncoming()}
              className="flex-1 px-4 py-2 rounded border border-[var(--surface-border)] text-on-surface-primary text-sm font-medium hover:bg-surface-tertiary"
              data-testid="screen-share-reject"
            >
              {aegisT(language, 'screenShare.rejectBtn')}
            </button>
            <button
              type="button"
              onClick={() => { void screenShareService.acceptIncoming(); }}
              className="flex-1 px-4 py-2 rounded bg-mist-500 hover:bg-mist-600 text-white text-sm font-medium"
              data-testid="screen-share-accept"
            >
              {aegisT(language, 'screenShare.acceptBtn')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ============================================
  // (2)/(3) 全螢幕 video viewer
  // ============================================
  if (active) {
    const senderLabel = labelFor(active.peerPubkey);
    return (
      <div
        className="fixed inset-0 z-50 bg-black flex flex-col"
        data-testid="screen-share-viewer"
      >
        <div
          className="flex justify-between items-center p-3 bg-surface-secondary text-on-surface-primary text-sm border-b border-[var(--surface-border)]"
          style={{
            // Mac: 留 traffic light 區避開(72px 系統 close/min/max 三顆 ~72px,
            // 再加 8px breathing room),避免 viewer 按鈕跟系統按鈕衝突造成「點不準」
            paddingLeft: typeof window !== 'undefined' && /Mac/.test(window.navigator.platform) ? 80 : undefined,
          }}
        >
          <span>
            {aegisT(language, 'screenShare.viewing')} <span className="font-medium">{senderLabel}</span>
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                const video = videoRef.current;
                if (video?.requestFullscreen) {
                  video.requestFullscreen().catch(() => { /* user denied / unsupported */ });
                }
              }}
              className="px-3 py-1.5 rounded border border-[var(--surface-border)] hover:bg-surface-tertiary text-sm min-w-[44px]"
              title={aegisT(language, 'screenShare.fullscreenBtn')}
            >
              ⛶
            </button>
            <button
              type="button"
              onClick={() => {
                // 通知 sender 停止(→ sender 端 stopSharing → DeviceListSidebar
                // 的「停投放」按鈕回 idle)。本機 viewer 直接 setActive(null) 收回。
                if (active?.peerPubkey) {
                  screenShareService.endReceiving(active.peerPubkey);
                }
                setActive(null);
              }}
              className="px-3 py-1.5 rounded border border-[var(--surface-border)] hover:bg-surface-tertiary text-sm min-w-[60px]"
              data-testid="screen-share-close"
            >
              {aegisT(language, 'screenShare.closeBtn')}
            </button>
          </div>
        </div>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="flex-1 w-full h-full object-contain bg-black"
        />
      </div>
    );
  }

  return null;
}
