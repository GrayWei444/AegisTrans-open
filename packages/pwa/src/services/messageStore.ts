/**
 * MessageStore — 訊息本機持久化
 *
 * 架構（aligned with AegisTalk database.ts schema）：
 *   - 文字訊息 + 檔案 metadata → SQLite via database.ts (`messages` table)
 *   - 檔案本體 → fileStore.ts：IndexedDB `aegistrans-blobs`（~2GB 上限）或
 *     native fs（>2GB stream-to-disk，FileMeta.fileStorage='fs'）
 *     （不進 SQLite 的理由：Capacitor bridge 傳大 blob 必須 base64 化，記憶體會炸）
 *
 * conversation_id 永遠是 'self'（AegisTrans 是自對自，沒有多對話概念）
 */

import * as db from './database';
import { putBlob, getBlob, deleteStoredFile } from './fileStore';

export type MessageType = 'text' | 'file';

export interface FileMeta {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  chunkSize: number;
  chunkCount: number;
  /**
   * 接收端專用：manifest 的寄送者 pubkey。隨 fileData 持久進 metadata JSON，
   * 讓「收到 manifest → 重啟 → 點下載」能重建 pendingFiles（否則純記憶體的
   * pendingFiles 在重啟後消失，fetchFile 找不到來源 = 死掉的下載鈕）。發送端不設。
   */
  fromPubkey?: string;
  /** 檔案本體存哪：'idb'（預設；舊訊息無此欄位=idb）| 'fs'（native stream-to-disk，>2GB）。 */
  fileStorage?: 'idb' | 'fs';
  /** fileStorage==='fs' 時的本機檔案路徑（接收端 finalize 後填；不隨 manifest 傳輸）。 */
  filePath?: string;
}

export interface Message {
  id: string;
  type: MessageType;
  content: string;
  created_at: number;
  from_device_id?: string;
  fileData?: FileMeta;
  fileBlob?: Blob;
  fileStatus?: 'pending' | 'complete' | 'failed';
}

const SELF_CONVERSATION_ID = 'self';

// 檔案本體存取搬到 fileStore.ts（idb/fs 雙後端抽象）。accountWipe 用的
// clearAllBlobs/hasAnyBlob 維持從這裡 re-export，呼叫端不用改。
export { clearAllBlobs, hasAnyBlob } from './fileStore';

// ============================================
// Helpers
// ============================================

function genId(): string {
  const ts = Date.now().toString(16).padStart(12, '0');
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  const rand = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${ts}-${rand}`;
}

let _selfConvPromise: Promise<unknown> | null = null;
function ensureSelfConversation(): Promise<unknown> {
  // Cache the in-flight promise (not a boolean) so concurrent callers
  // await the same INSERT instead of racing past a half-set flag and
  // hitting a FK violation on `messages.conversation_id`.
  if (!_selfConvPromise) {
    _selfConvPromise = db.run(
      `INSERT OR IGNORE INTO conversations (id, peer_pubkey, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [SELF_CONVERSATION_ID, 'self', 'self', Date.now(), Date.now()],
    ).catch((err) => {
      _selfConvPromise = null;  // allow retry on transient failure
      throw err;
    });
  }
  return _selfConvPromise;
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('unique') || msg.includes('primary key');
}

/** 轉義 SQL LIKE pattern 中的特殊字元（與 storage.ts ESCAPE '\\' 相同 pattern）。 */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_pubkey: string;
  content: string;
  msg_type: string;
  created_at: number;
  is_outgoing: number;
  status: string;
  metadata: string | null;
}

interface AegisTransMetadata {
  fileData?: FileMeta;
  fileStatus?: 'pending' | 'complete' | 'failed';
  from_device_id?: string;
}

function rowToMessage(row: MessageRow, blob?: Blob): Message {
  const meta: AegisTransMetadata = row.metadata ? JSON.parse(row.metadata) : {};
  return {
    id: row.id,
    type: (row.msg_type as MessageType) || 'text',
    content: row.content,
    created_at: row.created_at,
    from_device_id: meta.from_device_id,
    fileData: meta.fileData,
    fileBlob: blob,
    fileStatus: meta.fileStatus,
  };
}

// ============================================
// Public API (preserves messageStore.ts surface)
// ============================================

export async function addMessage(
  _userId: string,
  partial: Pick<Message, 'type' | 'content'> & {
    from_device_id?: string;
    fileData?: FileMeta;
    fileBlob?: Blob;
    fileStatus?: 'pending' | 'complete' | 'failed';
  },
): Promise<Message> {
  await ensureSelfConversation();
  const id = genId();
  const created_at = Date.now();
  const meta: AegisTransMetadata = {
    fileData: partial.fileData,
    fileStatus: partial.fileStatus,
    from_device_id: partial.from_device_id,
  };

  // Note: `sender_pubkey` is the AegisTalk schema column name; AegisTrans
  // stores `device_id` here (self-conversation has no real peer pubkey).
  await db.run(
    `INSERT INTO messages (id, conversation_id, sender_pubkey, content, msg_type, created_at, is_outgoing, status, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      SELF_CONVERSATION_ID,
      partial.from_device_id || 'self',
      partial.content,
      partial.type,
      created_at,
      1,  // addMessage = locally sent → outgoing
      'sent',
      JSON.stringify(meta),
    ],
  );

  if (partial.fileBlob && partial.fileData?.fileId) {
    await putBlob(partial.fileData.fileId, partial.fileBlob);
  }

  return {
    id,
    type: partial.type,
    content: partial.content,
    created_at,
    from_device_id: partial.from_device_id,
    fileData: partial.fileData,
    fileBlob: partial.fileBlob,
    fileStatus: partial.fileStatus,
  };
}

/** 從 peer 收到的訊息：使用對方傳來的 id + created_at，避免重複插入。 */
export async function addReceivedMessage(
  _userId: string,
  msg: Message,
): Promise<{ inserted: boolean; message: Message }> {
  await ensureSelfConversation();
  const meta: AegisTransMetadata = {
    fileData: msg.fileData,
    fileStatus: msg.fileStatus,
    from_device_id: msg.from_device_id,
  };

  try {
    await db.run(
      `INSERT INTO messages (id, conversation_id, sender_pubkey, content, msg_type, created_at, is_outgoing, status, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.id,
        SELF_CONVERSATION_ID,
        msg.from_device_id || 'self',
        msg.content,
        msg.type,
        msg.created_at,
        0,  // addReceivedMessage = from peer → incoming
        'received',
        JSON.stringify(meta),
      ],
    );
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { inserted: false, message: msg };
    }
    throw err;  // real DB error: don't swallow as "duplicate"
  }

  if (msg.fileBlob && msg.fileData?.fileId) {
    await putBlob(msg.fileData.fileId, msg.fileBlob);
  }

  return { inserted: true, message: msg };
}

export async function listMessages(_userId: string, limit = 200): Promise<Message[]> {
  await ensureSelfConversation();
  const rows = await db.query<MessageRow>(
    `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
    [SELF_CONVERSATION_ID, limit],
  );

  // Load blobs for file messages in parallel (N file rows = 1 round-trip wave)
  const messages = await Promise.all(rows.map(async (row) => {
    let blob: Blob | undefined;
    if (row.msg_type === 'file' && row.metadata) {
      try {
        const meta: AegisTransMetadata = JSON.parse(row.metadata);
        // fs 檔（>2GB stream-to-disk）本體在檔案系統，不在 IDB — 跳過無意義 lookup
        if (meta.fileData?.fileId && meta.fileData.fileStorage !== 'fs') {
          blob = await getBlob(meta.fileData.fileId);
        }
      } catch {
        // ignore
      }
    }
    return rowToMessage(row, blob);
  }));

  // 由舊到新（UI 由上往下）
  return messages.reverse();
}

export async function deleteMessage(_userId: string, id: string): Promise<void> {
  // Look up fileId before deleting (need it to clean blob after).
  const row = await db.queryOne<MessageRow>(
    `SELECT * FROM messages WHERE id = ? AND conversation_id = ?`,
    [id, SELF_CONVERSATION_ID],
  );

  // Delete the row FIRST. If we crash between, the worst case is an orphan
  // blob (recoverable via sweep) — never a row pointing at a missing blob
  // (which would render as a broken file bubble forever).
  await db.run(`DELETE FROM messages WHERE id = ? AND conversation_id = ?`, [id, SELF_CONVERSATION_ID]);

  if (row?.metadata) {
    try {
      const meta: AegisTransMetadata = JSON.parse(row.metadata);
      if (meta.fileData?.fileId) {
        await deleteStoredFile(meta.fileData);
      }
    } catch {
      // ignore
    }
  }
}

export async function clearAllMessages(_userId: string): Promise<void> {
  // Snapshot file rows' metadata, then delete rows first, blobs second
  // (orphan blob > broken UI; same reasoning as deleteMessage).
  const rows = await db.query<MessageRow>(
    `SELECT metadata FROM messages WHERE conversation_id = ? AND msg_type = 'file'`,
    [SELF_CONVERSATION_ID],
  );
  await db.run(`DELETE FROM messages WHERE conversation_id = ?`, [SELF_CONVERSATION_ID]);

  await Promise.all(rows.map(async (row) => {
    if (!row.metadata) return;
    try {
      const meta: AegisTransMetadata = JSON.parse(row.metadata);
      if (meta.fileData?.fileId) await deleteStoredFile(meta.fileData);
    } catch {
      // ignore
    }
  }));
}

/** 更新訊息（檔案傳輸完成後填 blob / fs 路徑用） */
export async function updateMessage(
  _userId: string,
  id: string,
  patch: Partial<Pick<Message, 'fileBlob' | 'fileStatus'>> & { fileDataPatch?: Partial<FileMeta> },
): Promise<void> {
  const row = await db.queryOne<MessageRow>(
    `SELECT * FROM messages WHERE id = ? AND conversation_id = ?`,
    [id, SELF_CONVERSATION_ID],
  );
  if (!row) return;

  let meta: AegisTransMetadata = {};
  try {
    meta = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    // ignore
  }

  if (patch.fileStatus !== undefined) meta.fileStatus = patch.fileStatus;
  // fs streaming finalize：把 fileStorage/filePath 併進 fileData（>2GB 收檔落盤後記路徑）
  if (patch.fileDataPatch && meta.fileData) {
    meta.fileData = { ...meta.fileData, ...patch.fileDataPatch };
  }

  await db.run(
    `UPDATE messages SET metadata = ? WHERE id = ?`,
    [JSON.stringify(meta), id],
  );

  if (patch.fileBlob && meta.fileData?.fileId) {
    await putBlob(meta.fileData.fileId, patch.fileBlob);
  }
}

/** 透過 fileId 找訊息（接收端 chunk 進來時定位 message）。
 *  jeep-sqlite 沒有 JSON ops，只能 LIKE serialized metadata；fileId 走 escapeLike 防 wildcard 污染
 *  （目前 UUID 都是 hex+dash，但 charset 哪天擴大才不會踩到 `%` `_`）。 */
export async function findMessageByFileId(_userId: string, fileId: string): Promise<Message | null> {
  const rows = await db.query<MessageRow>(
    `SELECT * FROM messages WHERE conversation_id = ? AND msg_type = 'file' AND metadata LIKE ? ESCAPE '\\'`,
    [SELF_CONVERSATION_ID, `%"fileId":"${escapeLike(fileId)}"%`],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const blob = await getBlob(fileId);
  return rowToMessage(row, blob);
}

/** fs 檔（>2GB stream-to-disk）總用量 — 只算「接收端」落在 app 目錄的檔；
 *  發送端的 filePath 指向使用者自己的源檔（app 沒另存一份），不占 app 儲存。 */
export async function sumReceivedFsFileSizes(): Promise<{ bytes: number; fileCount: number }> {
  try {
    const rows = await db.query<MessageRow>(
      `SELECT * FROM messages WHERE conversation_id = ? AND msg_type = 'file' AND is_outgoing = 0 AND metadata LIKE ?`,
      [SELF_CONVERSATION_ID, '%"fileStorage":"fs"%'],
    );
    let bytes = 0;
    let fileCount = 0;
    for (const row of rows) {
      try {
        const meta: AegisTransMetadata = row.metadata ? JSON.parse(row.metadata) : {};
        if (meta.fileData?.fileStorage === 'fs' && meta.fileData.filePath) {
          bytes += meta.fileData.size;
          fileCount += 1;
        }
      } catch {
        // ignore
      }
    }
    return { bytes, fileCount };
  } catch {
    return { bytes: 0, fileCount: 0 };
  }
}

// Debug: 暴露給 e2e test(沿用 fileTransfer.ts / peerSync.ts 既有 __aegisDebug pattern)
// 訊息存在 SQLite,不在 IndexedDB 的 messages object store —— spec 要查 file 收到狀態 / sha256 必須走這個 helper。
// CR-06/H-07：只在 dogfood/e2e build(VITE_DEBUG_TOOLS=1)曝露；release build tree-shake 掉(不洩漏訊息存取)。
import { DEBUG_TOOLS } from '../utils/debugFlags';
if (DEBUG_TOOLS && typeof window !== 'undefined') {
  // @ts-expect-error - 偷塞給 window
  window.__aegisDebug = window.__aegisDebug || {};
  // @ts-expect-error
  window.__aegisDebug.listMessages = (limit = 200) => listMessages('', limit);
}
