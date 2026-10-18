/**
 * ImageLightbox — 圖片全螢幕檢視
 *
 * 操作：
 *   - ESC / 點背景 / 點 × 關閉
 *   - 滑鼠滾輪縮放（簡化：固定 fit-screen）
 *   - 下載按鈕
 */

import { useEffect, useState } from 'react';

interface ImageLightboxProps {
  blob: Blob;
  name: string;
  onClose: () => void;
}

export function ImageLightbox({ blob, name, onClose }: ImageLightboxProps) {
  const [url, setUrl] = useState<string>('');

  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => { URL.revokeObjectURL(u); };
  }, [blob]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center"
      onClick={onClose}
    >
      {/* 上方 toolbar */}
      <div
        className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 to-transparent"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-white/80 text-sm truncate flex-1 mr-4">{name}</div>
        <div className="flex gap-2">
          <button
            onClick={handleDownload}
            className="px-3 py-1.5 rounded bg-surface-tertiary hover:bg-white/20 text-white text-sm flex items-center gap-1.5"
            title="下載"
          >
            ⬇ 下載
          </button>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded bg-surface-tertiary hover:bg-white/20 text-white text-lg flex items-center justify-center"
            title="關閉 (Esc)"
          >
            ×
          </button>
        </div>
      </div>

      {/* 圖片 */}
      {url && (
        <img
          src={url}
          alt={name}
          className="max-w-[95vw] max-h-[95vh] object-contain cursor-zoom-out"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        />
      )}
    </div>
  );
}
