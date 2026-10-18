/**
 * Timeline — 自己對自己的訊息流
 *
 * Phase 1.4 + 1.5 minimum：純文字 + IndexedDB 本機持久化。
 * 後續：檔案上傳、跨裝置 sync、加密 chunks。
 */

import { useEffect, useRef, useState, useCallback, type DragEvent } from 'react';
import { useMessages } from '../hooks/useMessages';
import { ChatInput, type ChatInputHandle } from '../components/ChatInput';
import { ImageLightbox } from '../components/ImageLightbox';
import type { Message } from '../services/messageStore';
import type { Device } from '../services/auth';
import type { FileProgress } from '../services/fileTransfer';
import { isFileTransferReady, waitForFileComplete } from '../services/fileTransfer';
import { enqueueAutoFetch } from '../services/autoFetchQueue';
import { isPeerSyncReady } from '../services/peerSync';
import { SyncingIndicator } from '../components/common/SyncingIndicator';
import { openFile, previewFile, shareFile, canPreviewInBrowser, isExecutableFile, openFsFile, saveFsFile, shareFsFile } from '../services/fileOpener';
import { FilePreviewModal } from '../components/FilePreview/FilePreviewModal';
import { precheckStorageFor, formatBytes as fmtStorageBytes } from '../services/storageEstimate';
import { isTierGateError, SINGLE_FILE_IDB_MAX, isFsStreamPlatform } from '../services/tierGate';
import { useSubscriptionStore } from '../stores/subscriptionStore';
import { useLanguage } from '../i18n/context';
import { aegisT } from '../i18n/aegistrans-strings';
import { getActiveServer, webHost } from '../services/serverChoice';

interface TimelineProps {
  userId: string;
  currentDeviceId: string | null;
  devices: Device[];
}

export function Timeline({ userId, currentDeviceId, devices }: TimelineProps) {
  const { messages, isLoading, fileProgress, sendText, sendFile, deleteMessage } = useMessages(userId);
  const listRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const { language } = useLanguage();

  // 登入後 P2P/訊息層要幾秒才 init 完（+ 同步歷史）。這段時間 presence 已上線但送訊會失效
  // → 顯示「同步中…」+ disable 輸入，ready 後才放行（像 LINE，避免「在線卻傳不動」的困惑）。
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    const check = () => {
      if (cancelled) return;
      if (isPeerSyncReady() && isFileTransferReady()) { setReady(true); return; }
      setTimeout(check, 400);
    };
    check();
    return () => { cancelled = true; };
  }, [ready]);

  // 自動捲到底
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  // 拖拉檔案 drop zone（整個對話區）—— counter pattern 解 child enter/leave 抖動。
  // 只在 dataTransfer.types 含 'Files' 時亮 overlay（拖文字選取不該觸發）。
  const [dragCounter, setDragCounter] = useState(0);
  const isDragOver = dragCounter > 0;

  const isFileDrag = (e: DragEvent<HTMLDivElement>): boolean => {
    return Array.from(e.dataTransfer.types).includes('Files');
  };

  const onDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDragCounter((c) => c + 1);
  }, []);

  const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDragCounter((c) => Math.max(0, c - 1));
  }, []);

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();   // 必要：否則 onDrop 不會 fire
  }, []);

  const onDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDragCounter(0);
    const file = e.dataTransfer.files[0];
    if (file) void chatInputRef.current?.processFile(file);
  }, []);

  return (
    <div
      className="flex flex-col h-full min-h-0 relative"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-testid="timeline-drop-zone"
    >
      {/* 訊息列表 */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4">
        {isLoading ? (
          <MessageSkeleton />
        ) : messages.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-2 max-w-2xl mx-auto">
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const showDateSeparator = !prev ||
                !sameDay(prev.created_at, m.created_at);
              const isMine = !m.from_device_id || m.from_device_id === currentDeviceId;
              const fromDevice = m.from_device_id
                ? devices.find((d) => d.id === m.from_device_id)
                : undefined;
              const progress = m.fileData ? fileProgress[m.fileData.fileId] : undefined;
              return (
                <div key={m.id}>
                  {showDateSeparator && <DateSeparator ts={m.created_at} />}
                  <MessageBubble
                    message={m}
                    isMine={isMine}
                    fromDeviceLabel={fromDevice?.label}
                    progress={progress}
                    onDelete={deleteMessage}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 同步中指示（ready 前顯示，手繪風圈圈）*/}
      {!ready && <SyncingIndicator />}

      {/* 輸入區（ChatInput 元件；拖拉走 Timeline 外層 → ref.processFile）
          ready 前 disabled → 輸入框/送出鈕鎖住，避免送訊失效 */}
      <ChatInput
        ref={chatInputRef}
        onSendText={sendText}
        onSendFile={sendFile}
        disabled={!ready}
      />

      {/* 拖拉時的全區 overlay：虛線 + 半透明 + 大字「拖到這邊上傳」*/}
      {isDragOver && (
        <div
          className="absolute inset-2 z-30 pointer-events-none border-4 border-dashed border-mist-400 rounded-xl bg-mist-500/15 backdrop-blur-sm flex items-center justify-center"
          data-testid="drop-zone-overlay"
        >
          <div className="text-center px-6">
            <div className="text-6xl mb-3">📥</div>
            <p className="text-xl font-semibold text-on-surface-primary">
              {aegisT(language, 'timeline.dropZoneHint')}
            </p>
            <p className="text-sm text-on-surface-secondary mt-1">
              {aegisT(language, 'timeline.dropZoneSubhint')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Loading skeleton — 取代純文字「載入中」，避免冷啟動 SQLite init 時看到空狀態。 */
function MessageSkeleton() {
  return (
    <div className="space-y-3 max-w-2xl mx-auto py-2 animate-pulse">
      {/* 接收方 bubble (左) */}
      <div className="flex justify-start">
        <div className="w-40 h-12 rounded-lg bg-surface-tertiary/60" />
      </div>
      {/* 自己的 bubble (右) */}
      <div className="flex justify-end">
        <div className="w-32 h-10 rounded-lg bg-mist-500/15" />
      </div>
      {/* 接收方 bubble (左) */}
      <div className="flex justify-start">
        <div className="w-56 h-16 rounded-lg bg-surface-tertiary/60" />
      </div>
      {/* 自己的 bubble (右) */}
      <div className="flex justify-end">
        <div className="w-44 h-12 rounded-lg bg-mist-500/15" />
      </div>
    </div>
  );
}

/** localStorage key — 已看過歡迎引導 */
const WELCOME_DISMISSED_KEY = 'aegistrans_welcomed';

// 媒體自動接收上限：≤ 此大小的圖/影片/音訊一收到就自動 fetch + 直接預覽（像 LINE）；
// 超過的才走手動「下載」pull-model。使用者決策(2026-07-15)：200MB。
const AUTO_FETCH_MEDIA_MAX = 200 * 1024 * 1024;

function EmptyState() {
  const { language } = useLanguage();
  const [showWelcome, setShowWelcome] = useState(() => {
    try {
      return localStorage.getItem(WELCOME_DISMISSED_KEY) !== '1';
    } catch {
      return false;
    }
  });

  const dismiss = () => {
    try { localStorage.setItem(WELCOME_DISMISSED_KEY, '1'); } catch { /* ignore */ }
    setShowWelcome(false);
  };

  if (!showWelcome) {
    return (
      <div className="text-center py-16 text-on-surface-tertiary" data-testid="empty-state">
        {/* 直接用 logo（盾牌+尾巴 = 真正的形狀），低透明度淡淡的 */}
        <img
          src="/logo-transparent.png"
          alt=""
          className="w-28 h-28 mx-auto mb-4 opacity-40"
          aria-hidden="true"
        />
        <p className="text-base">{aegisT(language, 'timeline.emptyTitle')}</p>
        <p className="text-sm mt-1 text-on-surface-tertiary">{aegisT(language, 'timeline.emptyHint')}</p>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto py-8" data-testid="welcome-onboarding">
      <div className="text-center mb-6">
        <div className="text-5xl mb-3">👋</div>
        <h2 className="text-xl font-semibold text-on-surface-primary mb-2">{aegisT(language, 'timeline.welcomeTitle')}</h2>
        <p className="text-base text-on-surface-secondary">{aegisT(language, 'timeline.welcomeIntro')}</p>
      </div>

      <div className="space-y-3">
        <div className="flex gap-3 p-3 bg-surface-tertiary rounded-lg">
          <div className="text-3xl">🪞</div>
          <div className="flex-1">
            <h3 className="text-base font-medium text-on-surface-primary mb-1">{aegisT(language, 'timeline.welcomeCard1Title')}</h3>
            <p className="text-sm text-on-surface-secondary leading-relaxed">
              {aegisT(language, 'timeline.welcomeCard1Body')}
            </p>
          </div>
        </div>

        <div className="flex gap-3 p-3 bg-surface-tertiary rounded-lg">
          <div className="text-3xl">🔐</div>
          <div className="flex-1">
            <h3 className="text-base font-medium text-on-surface-primary mb-1">{aegisT(language, 'timeline.welcomeCard2Title')}</h3>
            <p className="text-sm text-on-surface-secondary leading-relaxed">
              {aegisT(language, 'timeline.welcomeCard2Body')}
            </p>
          </div>
        </div>

        <div className="flex gap-3 p-3 bg-surface-tertiary rounded-lg">
          <div className="text-3xl">📱</div>
          <div className="flex-1">
            <h3 className="text-base font-medium text-on-surface-primary mb-1">{aegisT(language, 'timeline.welcomeCard3Title')}</h3>
            <p className="text-sm text-on-surface-secondary leading-relaxed">
              {aegisT(language, 'timeline.welcomeCard3Body').replace('{web}', webHost(getActiveServer().webUrl) ?? aegisT(language, 'timeline.webFallback'))}
            </p>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={dismiss}
        className="mt-6 w-full py-3 bg-mist-500 hover:bg-mist-600 text-white text-base rounded-lg transition-colors"
        data-testid="welcome-dismiss"
      >
        {aegisT(language, 'timeline.welcomeDismissBtn')}
      </button>
    </div>
  );
}

function DateSeparator({ ts }: { ts: number }) {
  const { language } = useLanguage();
  const d = new Date(ts);
  const today = new Date();
  let label: string;
  if (sameDay(ts, today.getTime())) {
    label = aegisT(language, 'date.today');
  } else {
    const yesterday = new Date(today.getTime() - 86400000);
    if (sameDay(ts, yesterday.getTime())) {
      label = aegisT(language, 'date.yesterday');
    } else {
      label = d.toLocaleDateString(language === 'en' ? 'en-US' : language, {
        year: 'numeric', month: 'short', day: 'numeric',
      });
    }
  }
  return (
    <div className="flex items-center justify-center my-3">
      <span className="text-sm uppercase tracking-wider text-on-surface-tertiary bg-surface-tertiary px-2 py-0.5 rounded-full">
        {label}
      </span>
    </div>
  );
}

interface BubbleProps {
  message: Message;
  isMine: boolean;
  fromDeviceLabel?: string;
  progress?: FileProgress;
  onDelete: (id: string) => void;
}

function MessageBubble({ message, isMine, fromDeviceLabel, progress, onDelete }: BubbleProps) {
  const { language } = useLanguage();
  const d = new Date(message.created_at);
  const time = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  const handleCopy = async () => {
    if (message.type === 'text') {
      try {
        await navigator.clipboard.writeText(message.content);
      } catch (err) {
        console.error('Copy failed:', err);
      }
    }
  };

  /**
   * Delete 行為（抄 AegisTalk MessageBubble.tsx pattern）：
   *   - 不分 isMine / !isMine，按下都呼叫 onDelete(id)
   *   - useMessages.deleteMessage 內部會：本地 store 刪 + 廣播 encrypted_delete
   *     tombstone 給其他裝置 → 雙方都刪（自對自=多裝置都刪）
   */
  const handleDelete = () => {
    if (confirm(aegisT(language, 'msg.deleteConfirm'))) onDelete(message.id);
  };

  return (
    <div className={`flex gap-2 items-start ${isMine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] rounded-lg px-3 py-2 ${
        isMine
          ? 'bg-mist-500/20 border border-mist-500/20'
          : 'bg-surface-tertiary border border-[var(--surface-border)]'
      }`}>
        {!isMine && fromDeviceLabel && (
          <div className="text-[10px] text-mist-300 font-medium mb-0.5">
            {fromDeviceLabel}
          </div>
        )}
        {message.type === 'file' && message.fileData ? (
          <FileBubbleContent message={message} progress={progress} isMine={isMine} />
        ) : (
          <div className="whitespace-pre-wrap break-words text-sm text-on-surface-primary">
            {message.content}
          </div>
        )}
        {/* 訊息資訊列（時間 + 動作）— inline 跟 AegisTalk 對齊，圖示換成 Lucide 線條 SVG */}
        <div className={`flex items-center gap-1.5 mt-1 text-[10px] text-on-surface-secondary ${isMine ? 'justify-end' : 'justify-start'}`}>
          <span>{time}</span>
          {message.type === 'text' && (
            <button
              onClick={handleCopy}
              className="hover:text-mist-300 transition-colors p-1 -m-1 leading-none"
              title={aegisT(language, 'msg.copy')}
              aria-label={aegisT(language, 'msg.copy')}
            >
              <CopyIcon />
            </button>
          )}
          <button
            onClick={handleDelete}
            className="hover:text-red-400 transition-colors p-1 -m-1 leading-none"
            title={aegisT(language, 'msg.delete')}
            aria-label={aegisT(language, 'msg.delete')}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

/** 簡單 toast — 顯示 3 秒後自動消失 */
function showToast(text: string): void {
  const div = document.createElement('div');
  div.textContent = text;
  div.className = 'fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-surface-secondary text-on-surface-primary text-sm rounded-lg shadow-lg border border-[var(--surface-border)]';
  document.body.appendChild(div);
  setTimeout(() => {
    div.style.transition = 'opacity 0.3s';
    div.style.opacity = '0';
    setTimeout(() => div.remove(), 300);
  }, 2700);
}

function FileBubbleContent({ message, progress, isMine }: { message: Message; progress?: FileProgress; isMine: boolean }) {
  const { language } = useLanguage();
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState<string>('');
  // App 內預覽：PDF / 圖片 / 影片 / 音訊 / 文字 都直接 in-app 看，不跳出去
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const fileData = message.fileData;
  const blob = message.fileBlob;
  const isImage = fileData?.mimeType.startsWith('image/');
  const isVideo = fileData?.mimeType.startsWith('video/');
  const [videoUrl, setVideoUrl] = useState<string>('');

  // 為圖片建立 object URL（cleanup 在 unmount）
  useEffect(() => {
    if (isImage && blob) {
      const url = URL.createObjectURL(blob);
      setImageUrl(url);
      return () => { URL.revokeObjectURL(url); };
    }
  }, [isImage, blob]);

  // 為影片建立 object URL（收到的影片直接內嵌可播放預覽，像 LINE）
  useEffect(() => {
    if (isVideo && blob) {
      const url = URL.createObjectURL(blob);
      setVideoUrl(url);
      return () => { URL.revokeObjectURL(url); };
    }
  }, [isVideo, blob]);

  // Pull-model：B 點下載 → fetchFile → A 收到後送 chunks。也給下面的自動接收 effect 用。
  // ⚠️ 必須在 early-return 前定義（Rules of Hooks：useCallback）；fileData 為空時內部跳過。
  // 回傳是否「真的送出了 FILE_REQUEST 開始傳輸」— 自動接收佇列據此決定要不要 await 傳輸完成
  // （precheck 沒過就沒開始傳輸，佇列不該傻等 backstop）。
  const handleFetch = useCallback(async (): Promise<boolean> => {
    if (!fileData) return false;
    // 預檢本機 IndexedDB 空間夠不夠（大檔塞不下會浪費頻寬下載到一半失敗）。
    // >2GB fs-stream 收檔本體落 native 檔案系統、不進 IDB → origin quota 預檢會誤擋
    // （磁碟還有 100GB 也可能被 WebView 的 origin quota 卡住）；native freeBytes 預檢
    // 已在 fetchFile 內把關 → 這裡跳過 IDB 預檢（review 2026-07-20 #1）。
    const skipPrecheck = fileData.size > SINGLE_FILE_IDB_MAX && isFsStreamPlatform();
    const check = skipPrecheck ? { ok: true as const } : await precheckStorageFor(fileData.size);
    if (!check.ok && check.reason === 'quota_exceeded') {
      showToast(`⚠️ ${aegisT(language, 'chat.error.recvFull')} (${fmtStorageBytes(check.status.remaining)} 剩餘)`);
      return false;
    }
    if (!check.ok && check.reason === 'low_warning') {
      showToast(`⚠️ ${aegisT(language, 'chat.warn.storageLow')} (${fmtStorageBytes(check.status.remaining)} 剩餘)`);
    }
    try {
      const { fetchFile } = await import('../services/fileTransfer');
      await fetchFile(fileData.fileId);
      return true;
    } catch (err) {
      // 收檔端 tier gate（>2GB 單檔需 Pro）→ 開 paywall，不吐 raw error toast
      if (isTierGateError(err)) {
        useSubscriptionStore.getState().openPaywall({ reason: err.reason, details: err.details });
        return false;
      }
      console.error('[Timeline] fetchFile failed:', err);
      showToast(`⚠️ ${(err as Error).message}`);
      return false;
    }
  }, [fileData, language]);

  // 小型媒體（圖/影片/音訊）自動接收 → 直接顯示縮圖/可播放預覽（像 LINE），不用先按「下載」。
  // 大檔 / 文件檔仍保留 pull-model 手動下載（避免自動吃頻寬與儲存；純 P2P，仍不過 server）。
  // ⚠️ hooks 必須在任何 early-return 之前（Rules of Hooks）；fileData 為空時 effect 內部直接跳過。
  const autoFetchTriggered = useRef(false);
  useEffect(() => {
    if (autoFetchTriggered.current || !fileData) return;
    if (isMine || blob) return;
    if ((message.fileStatus ?? 'complete') !== 'pending') return;
    if (progress?.status === 'transferring') return;
    const mt = fileData.mimeType;
    const isSmallMedia =
      (mt.startsWith('image/') || mt.startsWith('video/') || mt.startsWith('audio/')) &&
      fileData.size <= AUTO_FETCH_MEDIA_MAX;
    if (!isSmallMedia) return;
    autoFetchTriggered.current = true;
    // 冷啟動時 Timeline 先 render 待接收 bubble，但 P2P/fileTransfer 還沒 init → 直接 fetchFile
    // 會 throw「not initialized」。輪詢等就緒才接收（最多 ~20s；沒等到就放棄，手動「下載」仍在）。
    let cancelled = false;
    let tries = 0;
    const fid = fileData.fileId;
    const tick = () => {
      if (cancelled) return;
      // 排進全域序列佇列（並行度 1）。job 要 await 到「真的收完/失敗」才 resolve，佇列才真正
      // 一次只收 1 個檔（fetchFile 送完 request 就 return，不代表收完 → 否則並行照舊）。
      if (isFileTransferReady()) {
        enqueueAutoFetch(fid, async () => {
          const started = await handleFetch();
          if (started) await waitForFileComplete(fid);
        });
        return;
      }
      if (++tries > 25) return;
      setTimeout(tick, 800);
    };
    tick();
    return () => { cancelled = true; };
  }, [isMine, blob, fileData, message.fileStatus, progress?.status, handleFetch]);

  if (!fileData) return null;
  const { name, size, mimeType } = fileData;
  const status = message.fileStatus ?? 'complete';
  const isTransferring = progress?.status === 'transferring';
  const pct = progress && progress.bytesTotal > 0
    ? Math.round((progress.bytesDone / progress.bytesTotal) * 100)
    : 0;

  // >2GB stream-to-disk：檔案本體在原生檔案系統（fileData.filePath），沒有 blob。
  // 儲存/開啟走 path IPC（磁碟對磁碟，不經 RAM/base64 — 大檔絕不能整個讀成 Blob）。
  const fsPath = fileData.fileStorage === 'fs' ? fileData.filePath : undefined;
  const hasContent = !!blob || !!fsPath;

  /** 另存到本地（桌面：跳檔案儲存對話框；手機：存到下載資料夾）*/
  const handleSaveLocal = async () => {
    if (!fileData) return;
    if (fsPath) {
      if (window.aegisElectron?.fstream) {
        // 桌面：原生另存對話框（磁碟對磁碟 copy）
        const r = await window.aegisElectron.fstream.saveAs(fsPath, name);
        if (r?.ok) showToast(`✓ ${name} ${aegisT(language, 'file.savedToDownloads')}`);
        else if (r && !r.canceled) showToast(`⚠️ ${r.error ?? '無法儲存檔案'}`);
      } else {
        // 行動端：Filesystem.copy 到 Documents（就地 copy，不經 RAM/base64）
        const r = await saveFsFile(fsPath, name);
        if (r.success) showToast(`✓ ${name} ${aegisT(language, 'file.savedToDownloads')}`);
        else showToast(`⚠️ ${r.error ?? '無法儲存檔案'}`);
      }
      return;
    }
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    try {
      const result = await openFile({ name, mimeType, dataUrl: url });
      if (result.success) {
        // 顯示輕量 toast（手機使用者特別需要）
        showToast(`✓ ${name} ${aegisT(language, 'file.savedToDownloads')}`);
      } else if (result.error) {
        showToast(`⚠️ ${result.error}`);
      }
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  };

  /**
   * 開啟 — 優先 in-app 預覽（FilePreviewModal: PDF / 圖 / 影片 / 音訊 / 文字 inline 看），
   * 其他類型（Word / Excel / ZIP / etc）才走系統 ACTION_VIEW，挑對應 app。
   *
   * 安全：執行檔（.exe / .apk / .sh / .deb / etc）開啟前彈警告，建議只儲存不要直接運行。
   */
  const handleOpen = async () => {
    if (!hasContent || !fileData) return;

    // 執行檔警告 — 自己對自己場景仍允許繼續，但提醒風險
    if (isExecutableFile(name)) {
      const ok = window.confirm(
        `⚠️ 「${name}」是執行檔（.${name.split('.').pop()}）。\n\n` +
        `直接運行可能有安全風險。建議改用「儲存」按鈕存到本機，` +
        `確認來源無誤後再手動執行。\n\n` +
        `仍要開啟嗎？`
      );
      if (!ok) return;
    }

    // fs 檔（>2GB）：就地用系統預設 app 開（不做 in-app 預覽 — 大檔載進
    // blob URL 必 OOM；也不複製 temp — >2GB 複製太貴）。
    if (fsPath) {
      if (window.aegisElectron?.fstream) {
        const r = await window.aegisElectron.fstream.openPath(fsPath);
        if (r && !r.ok) showToast(`⚠️ ${r.error ?? '無法開啟檔案'}`);
      } else {
        // 行動端：FileOpener 直接開路徑（ACTION_VIEW / QuickLook）
        const r = await openFsFile(fsPath, mimeType);
        if (!r.success && r.error) showToast(`⚠️ ${r.error}`);
      }
      return;
    }
    if (!blob) return;

    if (canPreviewInBrowser(mimeType)) {
      setPreviewUrl(URL.createObjectURL(blob));
      return;
    }
    const url = URL.createObjectURL(blob);
    try {
      const result = await previewFile({ name, mimeType, dataUrl: url });
      if (!result.success && result.error) {
        showToast(`⚠️ ${result.error}`);
      }
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  };

  const handleClosePreview = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
  };

  /** 分享 — 顯式呼叫系統分享面板（LINE / Gmail / 雲端硬碟 等） */
  const handleShare = async () => {
    // fs 檔（>2GB）：桌面殼沒有系統 share sheet（shareFile 對 Electron 也是退回另存）
    // → 走另存；行動端走 share sheet（只遞 file uri，不讀進記憶體）。
    if (fsPath) {
      if (window.aegisElectron?.fstream) { await handleSaveLocal(); return; }
      const r = await shareFsFile(fsPath, name);
      if (!r.success && r.error) showToast(`⚠️ ${r.error}`);
      return;
    }
    if (!blob || !fileData) return;
    const url = URL.createObjectURL(blob);
    try {
      const result = await shareFile({ name, mimeType, dataUrl: url });
      if (!result.success && result.error) {
        showToast(`⚠️ ${result.error}`);
      }
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  };


  // 影片完成 → 內嵌可播放預覽（像 LINE，直接點播放，不用先「開啟」）。接收端加「另存」。
  if (isVideo && blob && status === 'complete' && videoUrl) {
    return (
      <div className="space-y-1.5">
        <video
          src={videoUrl}
          controls
          playsInline
          preload="metadata"
          className="rounded max-w-full max-h-72 bg-black"
        />
        <div className="flex items-center justify-between gap-2 text-[11px] text-on-surface-secondary">
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate" data-testid="file-name">{name}</span>
            <span className="flex-shrink-0">{formatBytes(size)}</span>
          </div>
          {!isMine && (
            <button
              onClick={handleSaveLocal}
              className="flex-shrink-0 px-2 py-0.5 rounded bg-mist-500 hover:bg-mist-400 text-navy-900 text-[11px] font-medium"
              title={aegisT(language, 'file.saveAs')}
            >
              ⬇ {aegisT(language, 'file.saveAs')}
            </button>
          )}
        </div>
      </div>
    );
  }

  // 圖片完成 → 縮圖（點擊開 lightbox）。
  // 接收端額外顯示「另存」按鈕；發送端自己有源檔不需要。
  if (isImage && blob && status === 'complete' && imageUrl) {
    return (
      <>
        <div className="space-y-1.5">
          <img
            src={imageUrl}
            alt={name}
            className="clickable rounded max-w-full max-h-72 cursor-zoom-in hover:opacity-90 transition-opacity"
            onClick={() => setLightboxOpen(true)}
          />
          <div className="flex items-center justify-between gap-2 text-[11px] text-on-surface-secondary">
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate" data-testid="file-name">{name}</span>
              <span className="flex-shrink-0">{formatBytes(size)}</span>
            </div>
            {!isMine && (
              <button
                onClick={handleSaveLocal}
                className="flex-shrink-0 px-2 py-0.5 rounded bg-mist-500 hover:bg-mist-400 text-navy-900 text-[11px] font-medium"
                title={aegisT(language, 'file.saveAs')}
              >
                ⬇ {aegisT(language, 'file.saveAs')}
              </button>
            )}
          </div>
        </div>
        {lightboxOpen && (
          <ImageLightbox
            blob={blob}
            name={name}
            onClose={() => setLightboxOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <div className="py-1">
      {/* 檔名 + 大小佔滿整行、完整顯示（長檔名換行不截斷）；按鈕移到下面一排，不再擠檔名 */}
      <div className="flex items-start gap-2">
        <div className="text-2xl flex-shrink-0">{getFileIcon(mimeType)}</div>
        <div className="min-w-0 flex-1">
          <div className="text-base text-on-surface-primary break-all" data-testid="file-name">{name}</div>
          <div className="text-sm text-on-surface-secondary">
            {formatBytes(size)}
            {isTransferring && progress && (
              <> · {aegisT(language, 'file.receiving')} {pct}%</>
            )}
            {!isTransferring && status === 'failed' && ` · ${aegisT(language, 'file.transferFailed')}`}
          </div>
        </div>
      </div>

      {/* 接收端 + 已收完 → 「開啟 / 儲存 / 分享」（放檔名下方一排，可 wrap）。
          「開啟」永遠顯示：可預覽→App 內預覽；其他（pptx/docx/zip…）→ 系統「用其他 App 開啟」選單。 */}
      {!isMine && hasContent && status === 'complete' && !isTransferring && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          <button
            onClick={handleOpen}
            className="px-2.5 py-1 rounded bg-surface-tertiary hover:bg-surface-secondary text-mist-300 text-sm border border-[var(--surface-border)]"
            title={aegisT(language, 'file.open')}
          >
            {aegisT(language, 'file.open')}
          </button>
          <button
            onClick={handleSaveLocal}
            className="px-2.5 py-1 rounded bg-mist-500 hover:bg-mist-400 text-navy-900 text-sm font-medium"
            title={aegisT(language, 'file.saveTitle')}
          >
            ⬇ {aegisT(language, 'file.save')}
          </button>
          <button
            onClick={handleShare}
            className="px-2.5 py-1 rounded bg-surface-tertiary hover:bg-surface-secondary text-on-surface-primary text-sm border border-[var(--surface-border)]"
            title={aegisT(language, 'file.shareTitle')}
          >
            {aegisT(language, 'file.share')}
          </button>
        </div>
      )}

      {/* 還沒收到（pending）或收失敗（failed）→ 「下載/重試 X MB」按鈕。
          failed 也要給按鈕：failReceive 的設計就是 manifest 仍在、使用者重點下載即重試 —
          原本只渲染 pending 導致 failed 卡片變死路（2026-07-19 Z Fold e2e 抓到）。 */}
      {!hasContent && (status === 'pending' || status === 'failed') && !isTransferring && (
        <div className="mt-2">
          <button
            onClick={handleFetch}
            data-testid="fetch-file-button"
            className="px-3 py-1.5 rounded bg-mist-500 hover:bg-mist-400 text-navy-900 text-sm font-medium"
          >
            ⬇ {status === 'failed' ? aegisT(language, 'msg.retryDownload') : aegisT(language, 'msg.download')} {formatBytes(size)}
          </button>
        </div>
      )}
      {isTransferring && (
        <div className="mt-1.5 w-full h-1.5 bg-surface-tertiary rounded overflow-hidden">
          <div
            className="h-full bg-mist-400 transition-all"
            style={{ width: `${pct}%` }}
            data-testid="file-progress"
          />
        </div>
      )}
      {previewUrl && fileData && (
        <FilePreviewModal
          file={{ name, mimeType, size, dataUrl: previewUrl }}
          onClose={handleClosePreview}
        />
      )}
    </div>
  );
}

// ============================================
// Inline SVG icons (Lucide style — 線條乾淨、跟 currentColor 走配色)
// ============================================

function TrashIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function getFileIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return '🖼';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.includes('pdf')) return '📄';
  if (mimeType.includes('zip') || mimeType.includes('compressed')) return '🗜';
  if (mimeType.startsWith('text/')) return '📝';
  return '📎';
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function sameDay(t1: number, t2: number): boolean {
  const a = new Date(t1);
  const b = new Date(t2);
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}
