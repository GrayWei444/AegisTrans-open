/**
 * PDFViewer - PDF 預覽元件
 * 使用 PDF.js 在瀏覽器中渲染 PDF 檔案
 */

import { useState, useEffect, useRef, useCallback } from 'react';
// legacy build：自帶 core-js polyfill（Uint8Array.prototype.toHex / toBase64 / fromBase64…），
// 這些是 Chrome 140 / Safari 18.4 / Firefox 133 才有的新 API。pdf.js 5.7 的 main + worker 都會用到，
// 舊瀏覽器沒有 → 一般 build 會丟「a.toHex is not a function」→「無法載入 PDF 檔案」。
// 改用 legacy（main + worker 都要）讓 PDF 預覽在舊瀏覽器（含舊 iOS Safari）也能開。(2026-06-23)
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

// 設定 PDF.js worker（legacy worker 同樣自帶 polyfill）
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

interface PDFViewerProps {
  /** PDF 檔案的 URL 或 base64 data URL */
  src: string;
  /** 檔案名稱 */
  fileName?: string;
  /** 關閉回調 */
  onClose: () => void;
}

export function PDFViewer({ src, fileName, onClose }: PDFViewerProps) {
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 載入 PDF 文件
  useEffect(() => {
    let cancelled = false;

    const loadPdf = async () => {
      try {
        setLoading(true);
        setError(null);

        const loadingTask = pdfjsLib.getDocument(src);
        const pdf = await loadingTask.promise;

        if (cancelled) return;

        setPdfDoc(pdf);
        setNumPages(pdf.numPages);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        console.error('[PDFViewer] 載入 PDF 失敗:', err);
        setError('無法載入 PDF 檔案');
        setLoading(false);
      }
    };

    loadPdf();

    return () => {
      cancelled = true;
    };
  }, [src]);

  // 渲染當前頁面
  const renderPage = useCallback(async () => {
    if (!pdfDoc || !canvasRef.current) return;

    try {
      const page = await pdfDoc.getPage(currentPage);
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');

      if (!context) return;

      // 計算適合容器的縮放比例
      const containerWidth = containerRef.current?.clientWidth || window.innerWidth - 32;
      const viewport = page.getViewport({ scale: 1 });
      const baseScale = (containerWidth - 32) / viewport.width;
      const finalScale = baseScale * scale;

      const scaledViewport = page.getViewport({ scale: finalScale });

      // 設定 canvas 尺寸
      canvas.height = scaledViewport.height;
      canvas.width = scaledViewport.width;

      // 渲染頁面
      await page.render({
        canvasContext: context,
        viewport: scaledViewport,
        canvas: canvas,
      }).promise;
    } catch (err) {
      console.error('[PDFViewer] 渲染頁面失敗:', err);
    }
  }, [pdfDoc, currentPage, scale]);

  // 當 PDF 載入完成或頁碼/縮放改變時重新渲染
  useEffect(() => {
    renderPage();
  }, [renderPage]);

  // 上一頁
  const goToPrevPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1);
    }
  };

  // 下一頁
  const goToNextPage = () => {
    if (currentPage < numPages) {
      setCurrentPage(currentPage + 1);
    }
  };

  // 放大
  const zoomIn = () => {
    if (scale < 3) {
      setScale(Math.min(scale + 0.25, 3));
    }
  };

  // 縮小
  const zoomOut = () => {
    if (scale > 0.5) {
      setScale(Math.max(scale - 0.25, 0.5));
    }
  };

  // 重置縮放
  const resetZoom = () => {
    setScale(1.0);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col safe-area-top safe-area-bottom">
      {/* 頂部工具列 */}
      <div className="flex items-center justify-between px-4 py-3 bg-surface-tertiary border-b border-[var(--surface-border)]">
        {/* 左側：檔案名稱 */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-red-500 text-xl">
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/>
              <path d="M14 2v6h6"/>
              <path d="M10 12h4M10 16h4"/>
            </svg>
          </span>
          <span className="text-white text-sm truncate">
            {fileName || 'PDF 檔案'}
          </span>
        </div>

        {/* 中間：頁碼控制 */}
        <div className="flex items-center gap-2">
          <button
            onClick={goToPrevPage}
            disabled={currentPage <= 1}
            className="p-2 text-white disabled:text-on-surface-tertiary hover:bg-surface-secondary rounded transition-colors"
            title="上一頁"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          <span className="text-white text-sm min-w-[80px] text-center">
            {currentPage} / {numPages}
          </span>

          <button
            onClick={goToNextPage}
            disabled={currentPage >= numPages}
            className="p-2 text-white disabled:text-on-surface-tertiary hover:bg-surface-secondary rounded transition-colors"
            title="下一頁"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        {/* 右側：縮放和關閉 */}
        <div className="flex items-center gap-2 flex-1 justify-end">
          <button
            onClick={zoomOut}
            disabled={scale <= 0.5}
            className="p-2 text-white disabled:text-on-surface-tertiary hover:bg-surface-secondary rounded transition-colors"
            title="縮小"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>

          <button
            onClick={resetZoom}
            className="px-2 py-1 text-white text-sm hover:bg-surface-secondary rounded transition-colors min-w-[50px]"
            title="重置縮放"
          >
            {Math.round(scale * 100)}%
          </button>

          <button
            onClick={zoomIn}
            disabled={scale >= 3}
            className="p-2 text-white disabled:text-on-surface-tertiary hover:bg-surface-secondary rounded transition-colors"
            title="放大"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>

          <div className="w-px h-6 bg-[var(--surface-border)] mx-2" />

          <button
            onClick={onClose}
            className="p-2 text-white hover:bg-surface-secondary rounded transition-colors"
            title="關閉"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* PDF 內容區域 */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto flex items-start justify-center p-4"
      >
        {loading && (
          <div className="flex flex-col items-center justify-center h-full text-white">
            <div className="animate-spin rounded-full h-12 w-12 border-4 border-mist-500 border-t-transparent mb-4" />
            <span>載入中...</span>
          </div>
        )}

        {error && (
          <div className="flex flex-col items-center justify-center h-full text-red-400">
            <svg className="w-16 h-16 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && (
          <canvas
            ref={canvasRef}
            className="shadow-2xl"
            style={{ maxWidth: '100%' }}
          />
        )}
      </div>

      {/* 底部提示 */}
      <div className="px-4 py-2 bg-surface-tertiary border-t border-[var(--surface-border)] text-center">
        <span className="text-on-surface-tertiary text-xs">
          滑動翻頁 | 雙指縮放
        </span>
      </div>
    </div>
  );
}

export default PDFViewer;
