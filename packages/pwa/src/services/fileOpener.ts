/**
 * Phase 14: 檔案開啟服務
 *
 * 提供用系統預設應用程式開啟檔案的功能
 * - 在 PWA 中，主要透過下載並讓系統處理
 * - 在原生 App 中，可以使用 Capacitor 插件
 */

import { devLog, devWarn } from '../utils/devLog';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { FileOpener } from '@capawesome-team/capacitor-file-opener';
import { isElectron } from '../utils/electronEnv';

// ============================================
// C-3 (2026-05-07)：sender-supplied filename → filesystem path 防注入
//
// 對方裝置送來的 manifest.name 不能直接拿去當 Filesystem.writeFile 的 path：
// - `../../etc/passwd` 之類的相對路徑會跳出 Documents/Cache 範圍
// - `/absolute/path` 在某些 Android 版本會被解讀成 absolute（CVE 等級依 SDK 而定）
// - NUL / 控制字元在 Java 層會 throw 但會留下意外的 partial state
// - 過長檔名 (> 255 bytes) 在 ext4 / FAT 會被截斷或寫不進
//
// 對策：取 basename（去除 path 元件）→ 過濾控制字元 / 路徑分隔字元 →
// 截到 200 字節 → 空字串 fallback `file.bin`。
// ============================================
function sanitizeFileName(raw: string): string {
  if (!raw || typeof raw !== 'string') return 'file.bin';
  // basename：取最後一個 / 或 \ 之後（兩種 separator 都防 — Windows path）
  let name = raw.replace(/\\/g, '/').split('/').pop() ?? raw;
  // 去除 NUL + 控制字元 + 危險路徑字元（: ? * < > | "）—— 控制字元正是要清掉的目標，
  // 故意用 control-char range；no-control-regex 在此是 false positive。
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\x00-\x1f\x7f:?*<>|"]/g, '_');
  // 開頭點開頭（隱藏檔）+ 開頭破折號（誤當參數）→ 加 underscore prefix
  if (name.startsWith('.') || name.startsWith('-')) name = '_' + name;
  // 過長截斷（保留副檔名）— 200 bytes 安全範圍
  const enc = new TextEncoder();
  if (enc.encode(name).byteLength > 200) {
    const dotIdx = name.lastIndexOf('.');
    const ext = dotIdx > 0 && dotIdx > name.length - 16 ? name.slice(dotIdx) : '';
    let base = ext ? name.slice(0, name.length - ext.length) : name;
    while (enc.encode(base + ext).byteLength > 200 && base.length > 0) {
      base = base.slice(0, -1);
    }
    name = base + ext;
  }
  // 空字串 fallback
  return name.trim() || 'file.bin';
}

// ============================================
// 類型定義
// ============================================

export interface FileOpenOptions {
  /** 檔案名稱 */
  name: string;
  /** MIME 類型 */
  mimeType: string;
  /** 檔案內容 (base64 data URL 或 blob URL) */
  dataUrl: string;
}

export interface FileOpenResult {
  /** 是否成功 */
  success: boolean;
  /** 錯誤訊息 */
  error?: string;
}

// ============================================
// 檢測功能支援
// ============================================

/**
 * 檢查是否支援 File System Access API (用於儲存到特定位置)
 */
export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

/**
 * 檢查是否為原生 App (Capacitor)
 */
export function isNativeApp(): boolean {
  return typeof (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform === 'function'
    && (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor!.isNativePlatform!();
}

/**
 * 檢查是否為 iOS
 */
export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

/**
 * 檢查是否為 Android
 */
export function isAndroid(): boolean {
  return /Android/.test(navigator.userAgent);
}

// ============================================
// >2GB fs 檔（native 路徑，無 blob）— 行動端就地操作
//
// 檔案本體在原生檔案系統（fileData.filePath，AegisFileStream plugin 收檔落盤）。
// 開啟 = FileOpener 直接開路徑；儲存 = Filesystem.copy 磁碟對磁碟；分享 = share sheet
// 帶 file uri。**絕不把檔案讀進 JS（base64/blob）— >2GB 必 OOM**。桌面 Electron 走
// 既有 window.aegisElectron.fstream.saveAs/openPath，不用這組。
// ============================================

function toFileUri(path: string): string {
  return path.startsWith('/') ? 'file://' + path : path;
}

/** 就地用系統 app 開啟 fs 檔（行動端）。 */
export async function openFsFile(path: string, mimeType: string): Promise<FileOpenResult> {
  try {
    await FileOpener.openFile({ path, mimeType });
    return { success: true };
  } catch (err) {
    const e = err as Error;
    console.error(`[FileOpener] openFsFile failed: ${e?.message || String(e)}`);
    if (e?.message?.includes('No app') || e?.message?.includes('UNAVAILABLE')) {
      // 沒 app 吃這個 mime → 退 share sheet（不複製檔案，只遞 uri）
      return shareFsFile(path, path.split('/').pop() ?? 'file', '開啟方式');
    }
    return { success: false, error: e?.message || '無法開啟檔案' };
  }
}

/** 另存 fs 檔到 Documents（行動端；磁碟對磁碟 copy，檔案管理員看得到）。 */
export async function saveFsFile(path: string, name: string): Promise<FileOpenResult> {
  try {
    await Filesystem.copy({
      from: path,
      to: sanitizeFileName(name),
      toDirectory: Directory.Documents,
    });
    return { success: true };
  } catch (err) {
    const e = err as Error;
    console.error(`[FileOpener] saveFsFile failed: ${e?.message || String(e)}`);
    return { success: false, error: e?.message || '無法儲存檔案' };
  }
}

/** 分享 fs 檔（行動端 share sheet；只遞 file uri，接收 app 自己讀）。 */
export async function shareFsFile(path: string, name: string, dialogTitle = '分享至'): Promise<FileOpenResult> {
  try {
    await Share.share({ title: name, text: name, url: toFileUri(path), dialogTitle });
    return { success: true };
  } catch (err) {
    const e = err as Error;
    if (e?.message?.toLowerCase().includes('cancel')) return { success: true };
    console.error(`[FileOpener] shareFsFile failed: ${e?.message || String(e)}`);
    return { success: false, error: e?.message || '無法分享檔案' };
  }
}

// ============================================
// 檔案開啟功能
// ============================================

/**
 * 「儲存」(save to phone storage) — 不彈 share sheet。
 * Capacitor native：寫到 Documents 資料夾（手機檔案管理員「文件」分類看得到）。
 * Web：File System Access API（桌面 Chrome 跳存檔對話框）/ <a download>。
 */
export async function openFile(options: FileOpenOptions): Promise<FileOpenResult> {
  const { name, mimeType, dataUrl } = options;

  // 行動 native（iOS/Android）→ Documents（手機檔案管理員看得到）。
  if (isNativeApp() && !isElectron()) {
    return saveNativeOnly(options);
  }

  // Electron 桌面殼雖然 Capacitor.isNativePlatform()===true，但 saveNativeOnly 會寫進
  // Capacitor 虛擬 Documents（Mac/Win 的 Finder/檔案總管都找不到 → 等於存不了）。改走
  // main process IPC：dialog.showSaveDialog 跳真原生另存對話框，寫到使用者選的真實路徑。
  // showSaveFilePicker 在 Electron custom scheme 下不保證可用，所以不賭它。
  if (isElectron() && window.aegisElectron?.saveFile) {
    try {
      const base64 = await dataUrlToBase64(dataUrl);
      const r = await window.aegisElectron.saveFile(sanitizeFileName(name), base64);
      if (r.ok || r.canceled) return { success: true };
      return { success: false, error: r.error || '無法儲存檔案' };
    } catch (err) {
      console.error('[FileOpener] Electron saveFile failed:', err);
      return { success: false, error: (err as Error).message || '無法儲存檔案' };
    }
  }

  try {
    devLog('[FileOpener] Opening file:', name, mimeType);

    // 將 data URL 轉為 Blob
    const response = await fetch(dataUrl);
    const blob = await response.blob();

    // 建立 Object URL
    const objectUrl = URL.createObjectURL(blob);

    // 方法 1: 嘗試使用 File System Access API (Chrome 86+)
    if (supportsFileSystemAccess() && !isIOS()) {
      try {
        const handle = await (window as { showSaveFilePicker?: (options: {
          suggestedName: string;
          types: Array<{ description: string; accept: Record<string, string[]> }>;
        }) => Promise<FileSystemFileHandle> }).showSaveFilePicker!({
          suggestedName: name,
          types: [{
            description: getFileTypeDescription(mimeType),
            accept: { [mimeType]: [getFileExtension(name)] },
          }],
        });

        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();

        URL.revokeObjectURL(objectUrl);
        devLog('[FileOpener] File saved via File System Access API');
        return { success: true };
      } catch (err) {
        // 使用者取消或不支援
        if ((err as Error).name !== 'AbortError') {
          devWarn('[FileOpener] File System Access API failed, falling back:', err);
        }
      }
    }

    // 方法 2: 使用 <a> 標籤下載
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = name;

    // iOS Safari 處理
    if (isIOS()) {
      // iOS Safari 對於某些檔案類型會直接預覽而不是下載
      // 使用 target="_blank" 在新視窗開啟
      if (canPreviewInBrowser(mimeType)) {
        link.target = '_blank';
        link.removeAttribute('download');
      }
    }

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // 延遲釋放 URL
    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 1000);

    devLog('[FileOpener] File download triggered');
    return { success: true };
  } catch (err) {
    console.error('[FileOpener] Failed to open file:', err);
    return {
      success: false,
      error: (err as Error).message || '無法開啟檔案',
    };
  }
}

/**
 * 「開啟」 — 用系統預設應用程式打開檔案（不是 share sheet）。
 * Capacitor native：寫到 Cache → `FileOpener.openFile` 觸發 Android `Intent.ACTION_VIEW`，
 *   彈「開啟方式」對話框（PDF reader / 圖片預覽 etc，**不會** 列 LINE 之類的 share apps）。
 * Web：window.open(blob URL) 在新視窗預覽（PDF 內建瀏覽器處理）。
 */
export async function previewFile(options: FileOpenOptions): Promise<FileOpenResult> {
  const { name, dataUrl, mimeType } = options;

  // Electron 桌面殼:沒有 Capacitor FileOpener 原生實作,走 IPC 寫 temp + shell.openPath。
  if (isElectron() && window.aegisElectron?.openFile) {
    try {
      const base64 = await dataUrlToBase64(dataUrl);
      const r = await window.aegisElectron.openFile(sanitizeFileName(name), base64);
      if (r.ok) return { success: true };
      return { success: false, error: r.error || '無法開啟檔案' };
    } catch (err) {
      console.error('[FileOpener] Electron openFile failed:', err);
      return { success: false, error: (err as Error).message || '無法開啟檔案' };
    }
  }

  if (isNativeApp()) {
    return openWithSystemAppNative(options);
  }

  try {
    if (!canPreviewInBrowser(mimeType)) {
      // Web（非 native）無法叫系統「用其他 App 開啟」→ 退回下載（開不了就存下來），
      // 不再回錯誤。native/Electron 路徑在上面已分流到系統開啟選單。
      return openFile(options);
    }
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const newWindow = window.open(objectUrl, '_blank');
    if (!newWindow) {
      URL.revokeObjectURL(objectUrl);
      return { success: false, error: '無法開啟新視窗，請檢查彈出視窗阻擋器設定' };
    }
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    return { success: true };
  } catch (err) {
    console.error('[FileOpener] Failed to preview file:', err);
    return { success: false, error: (err as Error).message || '無法預覽檔案' };
  }
}

/**
 * 「分享」 — 顯式呼叫系統 share sheet（讓使用者選 LINE / Gmail / 雲端硬碟 等）。
 * Capacitor native：寫到 Documents → Share.share dialogTitle="分享至"。
 * Web：嘗試 navigator.share（Web Share API），不支援就 fallback 到 download。
 */
export async function shareFile(options: FileOpenOptions): Promise<FileOpenResult> {
  // Electron 桌面殼沒有統一的系統 share sheet,退回「另存」(save dialog) 讓使用者落地檔案。
  if (isElectron()) {
    return openFile(options);
  }
  if (isNativeApp()) {
    return saveAndShareNative({ ...options }, '分享至');
  }
  // Web Share API（手機瀏覽器有效）
  const navAny = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean; share?: (data: { files: File[] }) => Promise<void> };
  if (navAny.share && navAny.canShare) {
    try {
      const resp = await fetch(options.dataUrl);
      const blob = await resp.blob();
      const file = new File([blob], options.name, { type: options.mimeType });
      if (navAny.canShare({ files: [file] })) {
        await navAny.share({ files: [file] });
        return { success: true };
      }
    } catch (err) {
      const e = err as Error;
      if (e.name !== 'AbortError') {
        return { success: false, error: e.message || '分享失敗' };
      }
      return { success: true }; // 使用者取消
    }
  }
  // Fallback：當作下載處理
  return openFile(options);
}

/**
 * 儲存檔案到下載目錄
 */
export async function saveFile(options: FileOpenOptions): Promise<FileOpenResult> {
  // 目前實作與 openFile 相同
  return openFile(options);
}

// ============================================
// 輔助函數
// ============================================

/**
 * 檢查檔案是否可以在瀏覽器中預覽
 */
export function canPreviewInBrowser(mimeType: string): boolean {
  // SVG 可含 <script>/<foreignObject>，禁止直接預覽（XSS 風險）
  if (mimeType === 'image/svg+xml') return false;

  // 可以在瀏覽器中直接預覽的類型
  const previewableTypes = [
    'image/',
    'video/',
    'audio/',
    'application/pdf',
    'text/plain',
    'text/css',
    'application/json',
  ];

  return previewableTypes.some(type => mimeType.startsWith(type));
}

/**
 * 取得檔案類型描述
 */
function getFileTypeDescription(mimeType: string): string {
  if (mimeType.startsWith('image/')) return '圖片檔案';
  if (mimeType.startsWith('video/')) return '影片檔案';
  if (mimeType.startsWith('audio/')) return '音訊檔案';
  if (mimeType === 'application/pdf') return 'PDF 文件';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'Word 文件';
  if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return 'Excel 試算表';
  if (mimeType.includes('powerpoint') || mimeType.includes('presentation')) return 'PowerPoint 簡報';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z')) return '壓縮檔案';
  if (mimeType.startsWith('text/')) return '文字檔案';
  return '檔案';
}

/**
 * 從檔名取得副檔名
 */
function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.substring(lastDot);
}

/**
 * 執行檔副檔名清單（跨平台常見的可執行 / 安裝檔）。
 * 命中 → UI 在「開啟」時要彈警告，建議使用者只「儲存」不要直接執行。
 * 注意：傳輸不阻擋，只在開啟前提醒；自己對自己使用情境下使用者可以選擇繼續。
 */
const EXECUTABLE_EXTS: ReadonlySet<string> = new Set([
  // Windows
  '.exe', '.msi', '.bat', '.cmd', '.ps1', '.com', '.scr', '.vbs', '.wsf',
  // Android
  '.apk', '.aab', '.xapk',
  // macOS
  '.dmg', '.pkg', '.app',
  // Linux
  '.deb', '.rpm', '.appimage', '.run',
  // Cross-platform
  '.jar', '.sh', '.bash',
]);

/** 副檔名是不是執行檔（用於 UI 在開啟前提醒風險）。 */
export function isExecutableFile(filename: string): boolean {
  const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  return ext ? EXECUTABLE_EXTS.has(ext) : false;
}

/**
 * 取得建議的 MIME 類型
 */
export function getMimeType(filename: string): string {
  const ext = getFileExtension(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.7z': 'application/x-7z-compressed',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Native (Capacitor) 「開啟」：寫到 Cache → 用 FileOpener 觸發 Android `Intent.ACTION_VIEW`，
 * 彈「開啟方式」對話框（PDF reader / 圖片預覽等），**不會列 LINE / Gmail 等 share apps**。
 */
async function openWithSystemAppNative(options: FileOpenOptions): Promise<FileOpenResult> {
  const { name, mimeType, dataUrl } = options;
  try {
    const base64Data = await dataUrlToBase64(dataUrl);
    const result = await Filesystem.writeFile({
      path: sanitizeFileName(name),
      data: base64Data,
      directory: Directory.Cache,
      recursive: true,
    });
    console.error(`[FileOpener] cache saved: ${result.uri}, opening with mime=${mimeType}`);
    await FileOpener.openFile({
      path: result.uri,
      mimeType,
    });
    return { success: true };
  } catch (err) {
    const e = err as Error;
    console.error(`[FileOpener] openWithSystemApp failed: ${e?.message || String(e)}`);
    if (e?.message?.includes('No app') || e?.message?.includes('UNAVAILABLE')) {
      console.error('[FileOpener] no app handles mime, falling back to share');
      return saveAndShareNative(options, '開啟方式');
    }
    return { success: false, error: e?.message || '無法開啟檔案' };
  }
}

/**
 * Native (Capacitor) 「另存」：只寫到 Documents 目錄，**不開 Share sheet**。
 * 使用者在「文件」資料夾用內建檔案管理員看得到。caller 應自行 toast 告知路徑。
 */
async function saveNativeOnly(options: FileOpenOptions): Promise<FileOpenResult> {
  const { name, dataUrl } = options;
  try {
    const base64Data = await dataUrlToBase64(dataUrl);
    const result = await Filesystem.writeFile({
      path: sanitizeFileName(name),
      data: base64Data,
      directory: Directory.Documents,
      recursive: true,
    });
    console.error(`[FileOpener] saved (no share): ${result.uri}`);
    return { success: true };
  } catch (err) {
    const e = err as Error;
    console.error(`[FileOpener] native save failed: ${e?.message || String(e)}`);
    return { success: false, error: e?.message || '無法儲存檔案' };
  }
}

/** 把 dataUrl（不論 `data:base64,` 或 `blob:`）轉成純 base64 string。 */
async function dataUrlToBase64(dataUrl: string): Promise<string> {
  if (dataUrl.startsWith('data:') && dataUrl.includes(',')) {
    return dataUrl.split(',')[1];
  }
  // blob: URL → fetch + read as base64
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Native (Capacitor) 「開啟」：寫到 Documents 後用 Share sheet 觸發 ACTION_VIEW
 * （Android 會列出所有能處理該 mime 的 app — PDF reader 等）。
 * 使用者選 app 後直接看到檔案。
 */
async function saveAndShareNative(options: FileOpenOptions, dialogTitle: string = '開啟或分享'): Promise<FileOpenResult> {
  const { name, dataUrl } = options;
  try {
    const base64Data = await dataUrlToBase64(dataUrl);

    // 寫到 Documents（Android: /storage/emulated/0/Android/data/<pkg>/files/Documents/）
    // 檔案管理員「文件」分類看得到；不需要外部儲存權限。
    const result = await Filesystem.writeFile({
      path: sanitizeFileName(name),
      data: base64Data,
      directory: Directory.Documents,
      recursive: true,
    });
    console.error(`[FileOpener] saved native: ${result.uri}`);

    // 開系統 share sheet：使用者可選「在 PDF Reader 開啟」/「儲存到 Files」/「分享到 ...」
    try {
      await Share.share({
        title: name,
        text: name,
        url: result.uri,
        dialogTitle,
      });
    } catch (shareErr) {
      // 使用者取消 share 不算錯，但檔案已存
      const e = shareErr as Error;
      if (e?.message?.toLowerCase().includes('cancel')) {
        devLog('[FileOpener] share cancelled, file saved at', result.uri);
      } else {
        console.error(`[FileOpener] share failed (file is saved): ${e?.message || String(e)}`);
      }
    }

    return { success: true };
  } catch (err) {
    const e = err as Error;
    console.error(`[FileOpener] native save failed: ${e?.message || String(e)}`);
    return { success: false, error: e?.message || '無法儲存檔案' };
  }
}

export default {
  openFile,
  previewFile,
  saveFile,
  canPreviewInBrowser,
  supportsFileSystemAccess,
  isNativeApp,
  isIOS,
  isAndroid,
  getMimeType,
};
