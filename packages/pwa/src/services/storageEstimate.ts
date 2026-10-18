/**
 * Storage Estimate Helper
 *
 * 純 P2P 架構下，sender 必須本機暫存檔案直到 receiver 連上線下載。
 * 大檔案（200MB+）會吃掉 IndexedDB quota。本服務提供：
 *   - 估算可用空間（device-level：navigator.storage.estimate）
 *   - 估算 AegisTrans **自己**的用量（walk 'aegistrans-blobs' IDB store）
 *   - 預檢一個檔案能不能放進去
 *   - 給 UI 顯示「目前用了 X / Y GB」+「Pro tier gate：超過 2GB 觸發 paywall」
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { sumReceivedFsFileSizes } from './messageStore';

export interface StorageStatus {
  /** 已用 bytes */
  usage: number;
  /** quota bytes（瀏覽器分配上限）*/
  quota: number;
  /** 剩餘 bytes */
  remaining: number;
  /** 已用百分比 (0-100) */
  percentUsed: number;
  /** API 是否可用（Safari < 14 / 老瀏覽器可能無 navigator.storage.estimate）*/
  supported: boolean;
}

/** AegisTrans 自家用量（不包含其他 origin / 其他 IDB DB）。 */
export interface AegisTransUsage {
  /** aegistrans-blobs IDB store 內所有 blob bytes 總和 */
  bytes: number;
  /** blob 檔案數 */
  fileCount: number;
}

const FALLBACK_QUOTA = 1_000_000_000; // 1 GB 假設

export async function getStorageStatus(): Promise<StorageStatus> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return {
      usage: 0,
      quota: FALLBACK_QUOTA,
      remaining: FALLBACK_QUOTA,
      percentUsed: 0,
      supported: false,
    };
  }
  try {
    const estimate = await navigator.storage.estimate();
    const usage = estimate.usage ?? 0;
    const quota = estimate.quota ?? FALLBACK_QUOTA;
    const remaining = Math.max(0, quota - usage);
    const percentUsed = quota > 0 ? Math.min(100, (usage / quota) * 100) : 0;
    return { usage, quota, remaining, percentUsed, supported: true };
  } catch {
    return {
      usage: 0,
      quota: FALLBACK_QUOTA,
      remaining: FALLBACK_QUOTA,
      percentUsed: 0,
      supported: false,
    };
  }
}

// ============================================================
// Phase 1A.2 — AegisTrans-only usage tracking
// ============================================================

interface BlobDB extends DBSchema {
  blobs: { key: string; value: Blob };
}

/** 開 (read-only) handle 給 'aegistrans-blobs' DB。
 * 這支跟 messageStore.ts 內部的 _blobDbPromise 是不同 connection，但 IDB 允許多 handle 共存。
 * 之所以另開：messageStore 不該為了 usage tracking 暴露 internal handle。 */
async function openBlobDbReadOnly(): Promise<IDBPDatabase<BlobDB>> {
  return openDB<BlobDB>('aegistrans-blobs', 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs');
      }
    },
  });
}

/**
 * Walk aegistrans-blobs IDB store，加總所有 blob.size。
 *
 * 為什麼不直接用 navigator.storage.estimate()：
 *   - estimate() 包含 **整個 origin** 的 IDB（含 messageStore SQLite WAL、其他 stores）
 *   - 對 tier gate 來說太粗（user 不該被 SQLite cache 占用拖累）
 *   - 走 cursor 走完整個 store 才能得到 AegisTrans 自家檔案的真實用量
 *
 * 成本：對 200 個檔案 < 100ms（cursor 不讀 blob bytes，只看 metadata size）。
 */
export async function getAegisTransUsage(): Promise<AegisTransUsage> {
  if (typeof indexedDB === 'undefined') {
    return { bytes: 0, fileCount: 0 };
  }
  try {
    const db = await openBlobDbReadOnly();
    const tx = db.transaction('blobs', 'readonly');
    const store = tx.objectStore('blobs');
    let bytes = 0;
    let fileCount = 0;
    let cursor = await store.openCursor();
    while (cursor) {
      const blob = cursor.value;
      if (blob && typeof blob.size === 'number') {
        bytes += blob.size;
        fileCount += 1;
      }
      cursor = await cursor.continue();
    }
    await tx.done;
    // >2GB stream-to-disk 檔（本體在原生檔案系統，不在 IDB）一併納入
    const fs = await sumReceivedFsFileSizes();
    return { bytes: bytes + fs.bytes, fileCount: fileCount + fs.fileCount };
  } catch (e) {
    console.warn('[storageEstimate] getAegisTransUsage failed:', e);
    return { bytes: 0, fileCount: 0 };
  }
}

export type StoragePrecheckResult =
  | { ok: true }
  | { ok: false; reason: 'quota_exceeded'; status: StorageStatus; needed: number }
  | { ok: false; reason: 'low_warning'; status: StorageStatus; needed: number };

/**
 * 預檢：要塞 fileSize bytes 進來會發生什麼？
 *   - ok: 剩餘空間 > fileSize × 1.2（保留 20% 餘裕）
 *   - low_warning: 剩餘空間 < fileSize × 1.2 但 > fileSize（可繼續但要警告）
 *   - quota_exceeded: 剩餘空間 < fileSize（必須阻擋）
 */
export async function precheckStorageFor(fileSize: number): Promise<StoragePrecheckResult> {
  const status = await getStorageStatus();
  if (!status.supported) return { ok: true }; // 估不準，放行

  const needed = Math.ceil(fileSize * 1.2); // 20% 餘裕（metadata + 加密 overhead）

  if (status.remaining < fileSize) {
    return { ok: false, reason: 'quota_exceeded', status, needed: fileSize };
  }
  if (status.remaining < needed) {
    return { ok: false, reason: 'low_warning', status, needed };
  }
  return { ok: true };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
