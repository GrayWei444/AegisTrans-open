/**
 * useMessages — 訊息列表 + 操作（本機 + peer 即時接收）
 */

import { useState, useEffect, useCallback } from 'react';
import {
  type Message,
  listMessages,
  deleteMessage as deleteMessageStore,
  clearAllMessages as clearAllMessagesStore,
} from '../services/messageStore';
import { sendTextMessage, sendFile, onIncomingMessage, sendDeleteMessage, onMessageDeleted } from '../services/peerSync';
import { onFileProgress, type FileProgress } from '../services/fileTransfer';

interface UseMessagesResult {
  messages: Message[];
  isLoading: boolean;
  fileProgress: Record<string, FileProgress>;  // fileId → progress
  sendText: (content: string) => Promise<void>;
  sendFile: (file: File, caption?: string) => Promise<void>;
  deleteMessage: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useMessages(userId: string | null): UseMessagesResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [fileProgress, setFileProgress] = useState<Record<string, FileProgress>>({});

  // 監聽檔案傳輸進度
  useEffect(() => {
    if (!userId) return;
    const unsub = onFileProgress((p) => {
      setFileProgress((prev) => ({ ...prev, [p.fileId]: p }));
      // complete / failed 後 5 秒移除進度（讓 UI 短暫顯示完成提示）
      if (p.status !== 'transferring') {
        setTimeout(() => {
          setFileProgress((prev) => {
            const next = { ...prev };
            delete next[p.fileId];
            return next;
          });
        }, 5000);
      }
    });
    return unsub;
  }, [userId]);

  const refresh = useCallback(async () => {
    if (!userId) { setMessages([]); return; }
    const list = await listMessages(userId);
    setMessages(list);
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!userId) {
        setMessages([]);
        setIsLoading(false);
        return;
      }
      setIsLoading(true);
      try {
        const list = await listMessages(userId);
        // [DIAG] 印載入筆數 — 確認「對話空白」是不是 listMessages 偶發回空(HANDOFF §2)。
        // 用 console.error：Vite prod build 砍 log/warn，保留 error。
        console.error(`[DIAG:useMessages] loaded ${list.length} msgs for ${userId.slice(0, 8)}`);
        if (!cancelled) {
          setMessages(list);
        }
      } catch (err) {
        // listMessages 失敗（例如 SQLite init 卡住）也要把 loading 關掉，
        // 不然 timeline 會永遠卡在 MessageSkeleton，看不到 EmptyState/logo。
        console.error(`[useMessages] listMessages failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!cancelled) {
          setMessages([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  // 監聽 peer 進來的訊息，即時推到 UI（含 file 完成時的 update）
  useEffect(() => {
    if (!userId) return;
    const unsub = onIncomingMessage((msg) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === msg.id);
        if (idx >= 0) {
          // 已存在 → 更新（檔案完成 blob 進來、status 變化）
          const updated = [...prev];
          updated[idx] = msg;
          return updated;
        }
        return [...prev, msg].sort((a, b) => a.created_at - b.created_at);
      });
    });
    return unsub;
  }, [userId]);

  // 監聽 peer 進來的「刪訊息」tombstone，即時從 UI 移除（peerSync 已先把本地 store 刪掉）
  useEffect(() => {
    if (!userId) return;
    const unsub = onMessageDeleted((messageId) => {
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
    });
    return unsub;
  }, [userId]);

  const sendText = useCallback(async (content: string) => {
    if (!userId || !content.trim()) return;
    const msg = await sendTextMessage(content.trim());
    setMessages((prev) => [...prev, msg]);
  }, [userId]);

  const sendFileFn = useCallback(async (file: File, caption?: string) => {
    if (!userId) return;
    const msg = await sendFile(file, caption);
    setMessages((prev) => [...prev, msg]);
  }, [userId]);

  const deleteMessage = useCallback(async (id: string) => {
    if (!userId) return;
    // 1) 本地刪
    await deleteMessageStore(userId, id);
    setMessages((prev) => prev.filter((m) => m.id !== id));
    // 2) 廣播 tombstone 給其他裝置（抄 AegisTalk DELETE_MESSAGE pattern）
    void sendDeleteMessage(id).catch((err) =>
      console.error('[useMessages] sendDeleteMessage failed:', err)
    );
  }, [userId]);

  const clearAll = useCallback(async () => {
    if (!userId) return;
    await clearAllMessagesStore(userId);
    setMessages([]);
  }, [userId]);

  return { messages, isLoading, fileProgress, sendText, sendFile: sendFileFn, deleteMessage, clearAll, refresh };
}
