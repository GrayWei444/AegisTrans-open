/**
 * ChatInput — AegisTrans 訊息輸入元件（採用 AegisTalk 樣式）
 *
 * 支援：
 *   - 文字輸入（Enter 送、Shift+Enter 換行）
 *   - 檔案選擇（📎 按鈕、貼上、forwardRef.processFile 由 Timeline drop zone 呼叫）
 *   - 圖片預覽（pending 預覽 + 選填說明 + 送出按鈕）
 *   - 大檔分塊傳輸（fileTransfer 內部處理 streaming + tier gate）
 *
 * 拖拉整個對話區的 drop zone 在 Timeline.tsx 處理，會透過 ref 呼叫此元件的
 * processFile() — 改 dual-render-path bug 之後集中視覺回饋的設計。
 *
 * 不含 AegisTalk 的：語音、支付。
 */

import { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef, type KeyboardEvent } from 'react';
import { useLanguage } from '../i18n/context';
import { aegisT } from '../i18n/aegistrans-strings';
import { precheckStorageFor, formatBytes } from '../services/storageEstimate';
import { useSubscriptionStore } from '../stores/subscriptionStore';
import { isTierGateError, checkSingleFileSize, SINGLE_FILE_IDB_MAX, isFsSendPlatform } from '../services/tierGate';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

interface PendingFile {
  file: File;
  previewUrl: string;
  caption: string;
  isImage: boolean;
}

interface ChatInputProps {
  onSendText: (content: string) => Promise<void> | void;
  onSendFile: (file: File, caption?: string) => Promise<void> | void;
  disabled?: boolean;
}

/** Timeline 透過 ref 呼叫的命令式 API。 */
export interface ChatInputHandle {
  /** 把外部來源的 File（drop / paste / share）放進 pending preview。 */
  processFile: (file: File) => Promise<void>;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { onSendText, onSendFile, disabled }: ChatInputProps,
  ref,
) {
  const { language } = useLanguage();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<PendingFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const captionRef = useRef<HTMLTextAreaElement>(null);

  const isImage = (f: File) => IMAGE_TYPES.includes(f.type);

  const showError = (msg: string) => {
    setErrorMsg(msg);
    setTimeout(() => setErrorMsg(null), 6000);
  };

  const handleSendText = async () => {
    const t = message.trim();
    if (!t || busy || disabled) return;
    // S10：onSendText 是 async 且可能 reject（peerSync 未初始化 / 無 active group key）。
    // 舊碼同步呼叫不 await → rejection 逃逸、catch 永不觸發、setMessage('') 無條件清空
    // → 「按了 Enter、字消失、沒送出、沒報錯」(違反 §教訓2)。改成：樂觀清空（即時、防
    // 連按雙送），await 失敗則還原文字 + 顯示錯誤。
    setMessage('');
    try {
      await onSendText(t);
    } catch (err) {
      setMessage(t);
      showError(`送訊息失敗：${(err as Error).message}`);
    }
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendText();
    }
  };

  /**
   * Phase 1 收尾 bugfix：所有檔案類型統一走 pending preview + 送出 button 確認流程，
   * 避免「點 📎 → 選非圖檔 → 自動送 → fail silently」的 UX 黑洞。
   */
  const processFile = useCallback(async (file: File) => {
    // 單檔上限（>2GB stream-to-disk）：web 2GB 硬邊界；native free 2GB → paywall；native Pro 不限
    try {
      if ((await checkSingleFileSize(file.size)) === 'platform_limit') {
        showError(aegisT(language, 'chat.error.tooLarge'));
        return;
      }
    } catch (err) {
      if (isTierGateError(err)) {
        useSubscriptionStore.getState().openPaywall({ reason: err.reason, details: err.details });
        return;
      }
      throw err;
    }
    // 純 P2P：檔案要在本機 buffer 直到對方上線下載 → 預檢儲存空間。
    // 但 >2GB fs-stream 發送端「不 buffer 本機」（只記源檔路徑，重啟後串流讀），
    // 且本體不進 IDB → 用 navigator.storage.estimate 的 origin quota 預檢會誤擋
    // （WebView/Electron origin quota 可能遠小於磁碟）→ 跳過（review 2026-07-20 #1）。
    const skipPrecheck = file.size > SINGLE_FILE_IDB_MAX && isFsSendPlatform();
    const check = skipPrecheck ? { ok: true as const } : await precheckStorageFor(file.size);
    if (!check.ok && check.reason === 'quota_exceeded') {
      showError(
        `${aegisT(language, 'chat.error.storageFull')} (${formatBytes(check.status.remaining)} 剩餘 / 需 ${formatBytes(file.size)})`,
      );
      return;
    }
    if (!check.ok && check.reason === 'low_warning') {
      // 不阻擋，但警告
      showError(
        `${aegisT(language, 'chat.warn.storageLow')} (${formatBytes(check.status.remaining)} 剩餘)`,
      );
    }
    const isImg = isImage(file);
    const previewUrl = isImg ? URL.createObjectURL(file) : '';
    setPending({ file, previewUrl, caption: '', isImage: isImg });
    setTimeout(() => captionRef.current?.focus(), 50);
  }, [language]);

  const handleSendPending = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await onSendFile(pending.file, pending.caption.trim() || undefined);
      if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
      setPending(null);
    } catch (err) {
      // Tier gate 撞牆 → 開 paywall（不顯示 inline error）
      if (isTierGateError(err)) {
        useSubscriptionStore.getState().openPaywall({
          reason: err.reason,
          details: err.details,
        });
        return;
      }
      // 暴露真實錯誤給使用者（之前 silent fail → 「按了送出沒反應」UX）
      const m = (err as Error).message || String(err);
      // 把常見內部錯誤 map 成人話
      if (m.includes('No active group key')) {
        showError(aegisT(language, 'chat.error.noPeer'));
      } else if (m.includes('not initialized')) {
        showError(aegisT(language, 'chat.error.initializing'));
      } else if (m.includes('too large') || m.includes('File too large')) {
        showError(aegisT(language, 'chat.error.tooLarge'));
      } else if (m.includes('QuotaExceededError') || m.includes('quota')) {
        showError(aegisT(language, 'chat.error.storageFull'));
      } else {
        showError(`${aegisT(language, 'chat.error.generic')}: ${m}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCancelPending = () => {
    if (pending?.previewUrl) URL.revokeObjectURL(pending.previewUrl);
    setPending(null);
  };

  // 暴露 processFile 給 parent (Timeline drop zone) 透過 ref 呼叫
  useImperativeHandle(ref, () => ({ processFile }), [processFile]);

  // 貼上圖片（textarea 內貼到才有意義；drop 走 Timeline → ref.processFile）
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const f = item.getAsFile();
        if (f) processFile(f);
        return;
      }
    }
  }, [processFile]);

  useEffect(() => {
    return () => { if (pending) URL.revokeObjectURL(pending.previewUrl); };
  }, [pending]);

  return (
    <div className="border-t border-[var(--surface-border)]">
      {/* 錯誤訊息（自動 6 秒後消失） */}
      {errorMsg && (
        <div
          className="px-3 py-2 bg-red-500/15 border-b border-red-500/30 text-sm text-red-400"
          data-testid="chat-input-error"
          role="alert"
        >
          {errorMsg}
        </div>
      )}

      {/* 待送檔案預覽區（image / non-image 統一；移除說明文字欄位 — 直接上傳）*/}
      {pending && (
        <div className="px-3 pt-3 pb-2 border-b border-[var(--surface-border)]" data-testid="pending-file">
          <div className="max-w-2xl mx-auto flex items-center gap-3">
            <div className="relative flex-shrink-0">
              {pending.isImage ? (
                <img
                  src={pending.previewUrl}
                  alt="preview"
                  className="w-14 h-14 object-cover rounded-md"
                />
              ) : (
                <div className="w-14 h-14 rounded-md bg-surface-tertiary border border-[var(--surface-border)] flex flex-col items-center justify-center text-on-surface-secondary text-[11px] px-1">
                  <span className="text-xl">📄</span>
                  <span className="truncate w-full text-center">
                    {(pending.file.size / 1024 / 1024).toFixed(1)} MB
                  </span>
                </div>
              )}
              <button
                onClick={handleCancelPending}
                className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center hover:bg-red-400"
                title={aegisT(language, 'chat.cancel')}
                data-testid="cancel-pending"
              >
                ×
              </button>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-on-surface-secondary break-all">{pending.file.name}</div>
              <textarea
                ref={captionRef}
                value={pending.caption}
                onChange={(e) => setPending({ ...pending, caption: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendPending();
                  } else if (e.key === 'Escape') {
                    handleCancelPending();
                  }
                }}
                placeholder={aegisT(language, 'chat.captionPlaceholder')}
                data-testid="caption-input"
                rows={2}
                className="w-full mt-1 bg-surface-tertiary border border-[var(--surface-border)] rounded-md px-3 py-2 text-base
                           focus:outline-none focus:border-mist-400 resize-none break-words"
              />
            </div>
            <button
              onClick={handleSendPending}
              disabled={busy}
              data-testid="send-file-button"
              className="px-5 py-3 rounded-md bg-mist-500 hover:bg-mist-400 text-navy-900 text-base font-medium
                         disabled:opacity-50 self-end"
            >
              {busy ? aegisT(language, 'chat.sending') : aegisT(language, 'chat.send')}
            </button>
          </div>
        </div>
      )}

      {/* 主輸入區 */}
      <div className="p-3">
        <div className="max-w-2xl mx-auto flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            // accept="*/*" → Android Chrome 會列出相簿/媒體/Files 完整 picker；
            // 沒 accept 會 fallback 到只剩「相機 + Files」陽春版
            accept="*/*"
            data-testid="file-input"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await processFile(f);
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || busy}
            className="p-3 rounded-md bg-surface-tertiary hover:bg-surface-tertiary border border-[var(--surface-border)]
                       text-on-surface-primary disabled:opacity-40 flex-shrink-0"
            title={aegisT(language, 'chat.attachFile')}
            aria-label={aegisT(language, 'chat.attachFile')}
          >
            📎
          </button>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKey}
            onPaste={handlePaste}
            disabled={disabled || busy}
            placeholder={aegisT(language, 'chat.placeholder')}
            rows={2}
            className="flex-1 bg-surface-tertiary border border-[var(--surface-border)] rounded-md px-3 py-2 text-base
                       resize-none focus:outline-none focus:border-mist-400 focus:ring-1 focus:ring-mist-400
                       max-h-40 placeholder-gray-500 break-words"
            style={{ minHeight: '52px' }}
          />
          <button
            onClick={handleSendText}
            disabled={disabled || busy || !message.trim()}
            className="px-5 py-3 rounded-md bg-mist-500 hover:bg-mist-400 text-navy-900 text-base font-medium self-end
                       disabled:bg-mist-500/30 disabled:cursor-not-allowed flex-shrink-0"
          >
            {aegisT(language, 'chat.send')}
          </button>
        </div>
      </div>
    </div>
  );
});
