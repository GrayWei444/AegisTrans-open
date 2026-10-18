/**
 * FilePreviewModal - 檔案預覽 Modal
 * 根據檔案類型選擇適當的預覽方式
 * - PDF: 使用 PDFViewer 元件
 * - 圖片: 直接顯示
 * - 其他: 顯示下載提示
 */

import { useState, useEffect, lazy, Suspense } from 'react';
// PDFViewer 靜態 import 會把 ~1MB 的 pdfjs-dist 綁進主 bundle。PDF 預覽只在使用者開 PDF 時才需要，
// 改成 lazy import（code-split）→ pdf.js 移出主 bundle、App 啟動更快（review 2026-07-16）。
const PDFViewer = lazy(() => import('./PDFViewer').then((m) => ({ default: m.PDFViewer })));
import { openFile } from '../../services/fileOpener';
import { useLanguage } from '../../i18n/context';

interface FileInfo {
  /** 檔案名稱 */
  name: string;
  /** 檔案類型 (MIME type) */
  mimeType: string;
  /** 檔案大小 (bytes) */
  size: number;
  /** 檔案內容 (base64 data URL) */
  dataUrl: string;
}

interface FilePreviewModalProps {
  file: FileInfo;
  onClose: () => void;
}

/** 取得檔案類型的圖示 */
function getFileIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return '\u{1F5BC}\u{FE0F}';
  if (mimeType === 'application/pdf') return '\u{1F4C4}';
  if (mimeType.includes('word') || mimeType.includes('document')) return '\u{1F4DD}';
  if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return '\u{1F4CA}';
  if (mimeType.includes('powerpoint') || mimeType.includes('presentation')) return '\u{1F4FD}\u{FE0F}';
  if (mimeType.includes('audio')) return '\u{1F3B5}';
  if (mimeType.includes('video')) return '\u{1F3AC}';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z')) return '\u{1F4E6}';
  if (mimeType.includes('text')) return '\u{1F4C3}';
  return '\u{1F4CE}';
}

/** 格式化檔案大小 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// 文字預覽顯示上限：超大文字檔（如 50MB log）整份塞進單一 <pre> 會凍畫面 → 截斷顯示。
// ponytail: 1MB 顯示上限；要看完整檔案用「儲存」匯出後用文字編輯器開。
const TEXT_PREVIEW_MAX = 1_000_000;

export function FilePreviewModal({ file, onClose }: FilePreviewModalProps) {
  const { t } = useLanguage();
  const [downloading, setDownloading] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textTruncated, setTextTruncated] = useState(false);
  const [textScale, setTextScale] = useState(1);

  const isPDF = file.mimeType === 'application/pdf';
  const isImage = file.mimeType.startsWith('image/');
  const isVideo = file.mimeType.startsWith('video/');
  const isAudio = file.mimeType.startsWith('audio/');
  const isText = file.mimeType.startsWith('text/') || file.mimeType === 'application/json';

  // 文字檔：抓內容進 state，用 <pre> 自渲染（才有真正可控的字級縮放；iframe 縮放在手機不可靠）。
  useEffect(() => {
    if (!isText) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(file.dataUrl);
        const txt = await resp.text();
        if (cancelled) return;
        if (txt.length > TEXT_PREVIEW_MAX) {
          setTextContent(txt.slice(0, TEXT_PREVIEW_MAX));
          setTextTruncated(true);
        } else {
          setTextContent(txt);
        }
      } catch {
        if (!cancelled) setTextContent(t('file.textReadError'));
      }
    })();
    return () => { cancelled = true; };
  }, [isText, file.dataUrl, t]);

  // 共用 header — 所有 modal 預覽都用一樣的 top bar（安全區避狀態列）
  const renderHeader = () => (
    <div
      className="flex items-center justify-between px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] bg-surface-tertiary border-b border-[var(--surface-border)]"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className="text-xl">{getFileIcon(file.mimeType)}</span>
        <span className="text-white text-sm truncate">{file.name}</span>
        <span className="text-on-surface-tertiary text-xs">({formatFileSize(file.size)})</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="px-3 py-1.5 bg-mist-500 hover:bg-mist-600 text-white text-sm rounded transition-colors disabled:opacity-50"
        >
          {downloading ? t('file.downloading') : t('file.download')}
        </button>
        <button
          onClick={onClose}
          className="p-2 text-white hover:bg-surface-elevated rounded transition-colors"
          title={t('common.close')}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );

  // 下載檔案（使用 fileOpener 服務）
  const handleDownload = async () => {
    try {
      setDownloading(true);

      const result = await openFile({
        name: file.name,
        mimeType: file.mimeType,
        dataUrl: file.dataUrl,
      });

      if (!result.success) {
        console.error('[FilePreviewModal] Download failed:', result.error);
      }

      setDownloading(false);
    } catch (err) {
      console.error('[FilePreviewModal] Download failed:', err);
      setDownloading(false);
    }
  };

  // ESC 鍵關閉
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // PDF 預覽（PDFViewer 是 lazy chunk，載入中顯示 fallback）
  if (isPDF) {
    return (
      <Suspense fallback={<div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center text-white text-sm">{t('common.loading')}</div>}>
        <PDFViewer src={file.dataUrl} fileName={file.name} onClose={onClose} />
      </Suspense>
    );
  }

  // 影片 / 音訊 / 文字 預覽（in-app 直接看，不跳出去）
  if (isVideo) {
    return (
      <div className="fixed inset-0 z-50 bg-black/90 flex flex-col" onClick={onClose}>
        {renderHeader()}
        <div className="flex-1 flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
          <video src={file.dataUrl} controls autoPlay className="max-w-full max-h-full" />
        </div>
      </div>
    );
  }
  if (isAudio) {
    return (
      <div className="fixed inset-0 z-50 bg-black/90 flex flex-col" onClick={onClose}>
        {renderHeader()}
        <div className="flex-1 flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
          <audio src={file.dataUrl} controls autoPlay className="w-full max-w-md" />
        </div>
      </div>
    );
  }
  if (isText) {
    const clampScale = (s: number) => Math.min(3, Math.max(0.5, Math.round(s * 100) / 100));
    const fontPx = Math.round(14 * textScale);
    return (
      <div className="fixed inset-0 z-50 bg-black/90 flex flex-col" onClick={onClose}>
        {renderHeader()}
        {/* 字級縮放工具列 — A− / % / A＋ / 重設。用真正的 fontSize 控制，跨平台都可靠。 */}
        <div
          className="flex items-center justify-center gap-2 px-4 py-2 bg-surface-tertiary border-b border-[var(--surface-border)]"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => setTextScale((s) => clampScale(s - 0.15))}
            className="px-3 py-1 bg-surface-elevated hover:bg-surface-secondary text-white rounded text-sm"
            title={t('file.zoomOut')}
          >A－</button>
          <span className="text-on-surface-tertiary text-xs w-12 text-center tabular-nums">{Math.round(textScale * 100)}%</span>
          <button
            onClick={() => setTextScale((s) => clampScale(s + 0.15))}
            className="px-3 py-1 bg-surface-elevated hover:bg-surface-secondary text-white rounded text-sm"
            title={t('file.zoomIn')}
          >A＋</button>
          <button
            onClick={() => setTextScale(1)}
            className="px-2 py-1 text-on-surface-tertiary hover:text-white text-xs"
            title={t('file.zoomReset')}
          >{t('file.zoomReset')}</button>
        </div>
        <div className="flex-1 overflow-auto bg-white" onClick={(e) => e.stopPropagation()}>
          <pre
            style={{
              fontSize: `${fontPx}px`,
              lineHeight: 1.5,
              margin: 0,
              padding: '1rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: '#1a1a1a',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            }}
          >
            {textContent ?? t('common.loading')}
            {textTruncated ? `\n\n… ${t('file.textTruncated')}` : ''}
          </pre>
        </div>
      </div>
    );
  }

  // 圖片預覽
  if (isImage) {
    return (
      <div
        className="fixed inset-0 z-50 bg-black/90 flex flex-col"
        onClick={onClose}
      >
        {renderHeader()}

        <div
          className="flex-1 overflow-auto flex items-center justify-center p-4"
          onClick={(e) => e.stopPropagation()}
        >
          <img
            src={file.dataUrl}
            alt={file.name}
            className="max-w-full max-h-full object-contain"
          />
        </div>
      </div>
    );
  }

  // 其他檔案類型 - 顯示下載提示
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div
        className="bg-surface-secondary rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-[var(--surface-border)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center mb-6">
          <span className="text-6xl mb-4">{getFileIcon(file.mimeType)}</span>
          <h3 className="text-white text-lg font-medium text-center break-all">
            {file.name}
          </h3>
          <span className="text-on-surface-tertiary text-sm mt-1">
            {formatFileSize(file.size)}
          </span>
        </div>

        <p className="text-on-surface-secondary text-sm text-center mb-6">
          {t('file.unsupportedPreviewDownload')}
        </p>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 bg-surface-elevated hover:bg-surface-elevated text-white rounded-lg transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="flex-1 px-4 py-2.5 bg-mist-500 hover:bg-mist-600 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {downloading ? t('file.downloading') : t('file.downloadFile')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default FilePreviewModal;
