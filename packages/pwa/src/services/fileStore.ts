/**
 * FileStore — 檔案本體存放抽象（>2GB stream-to-disk 步驟 0）
 *
 * 兩種後端：
 *   - 'idb'：IndexedDB `aegistrans-blobs`（web/PWA 唯一路徑；單一 Blob ~2GB Chromium 硬邊界）
 *   - 'fs' ：native 檔案系統（Electron Node fs / Capacitor Filesystem），>2GB 走這條
 *
 * 訊息的 FileMeta.fileStorage 記錄檔案存哪；沒此欄位的舊訊息一律視為 'idb'。
 * fs 後端的寫入是「接收端串流落盤」（fileTransfer 直接寫檔，不經 putBlob——
 * 大檔不允許在記憶體裡組成 Blob），這裡只負責 idb 路徑 + fs 檔案的刪除/查詢介面。
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { getNativeFileStream } from './nativeFileStream';

interface BlobDB extends DBSchema {
  blobs: { key: string; value: Blob };
}

let _blobDbPromise: Promise<IDBPDatabase<BlobDB>> | null = null;

function getBlobDb(): Promise<IDBPDatabase<BlobDB>> {
  if (!_blobDbPromise) {
    _blobDbPromise = openDB<BlobDB>('aegistrans-blobs', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs');
        }
      },
    });
  }
  return _blobDbPromise;
}

export async function putBlob(fileId: string, blob: Blob): Promise<void> {
  const idb = await getBlobDb();
  await idb.put('blobs', blob, fileId);
}

export async function getBlob(fileId: string): Promise<Blob | undefined> {
  const idb = await getBlobDb();
  return idb.get('blobs', fileId);
}

export async function deleteBlob(fileId: string): Promise<void> {
  const idb = await getBlobDb();
  await idb.delete('blobs', fileId);
}

/**
 * 清空所有檔案 blob（CR-02 換帳號 wipe 用）。
 * 用「清空 object store」而非 indexedDB.deleteDatabase() —— 後者會被本模組快取的開啟連線
 * (`_blobDbPromise`) 卡住變成 fire-and-forget、blob 可能撐過 reload 殘留給下一帳號。
 * clear() 走既有連線、可 await，確實清乾淨。
 */
export async function clearAllBlobs(): Promise<void> {
  const idb = await getBlobDb();
  await idb.clear('blobs');
}

/** 是否還有任何檔案 blob（給換帳號的資料痕跡偵測用）。 */
export async function hasAnyBlob(): Promise<boolean> {
  const idb = await getBlobDb();
  return (await idb.count('blobs')) > 0;
}

/** 依 FileMeta 刪除檔案本體 — idb 走 deleteBlob；fs（>2GB）走 native 刪實體檔。 */
export async function deleteStoredFile(meta: { fileId: string; fileStorage?: 'idb' | 'fs'; filePath?: string }): Promise<void> {
  if (meta.fileStorage === 'fs') {
    // 只刪接收端落在 aegistrans-files/ 的檔（native 端會擋目錄外路徑 —
    // 發送端 filePath 指向使用者自己的源檔，本來就不該由刪訊息連帶刪除）。
    if (meta.filePath) await getNativeFileStream()?.delete(meta.filePath);
    return;
  }
  await deleteBlob(meta.fileId);
}
