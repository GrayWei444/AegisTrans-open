/**
 * ScreenSourcePicker — 桌面（Electron）多螢幕分享時的來源選擇器。
 *
 * 為何存在：桌面「投放螢幕」原本在 main process 直接授權第一個螢幕，多螢幕使用者無法選要分享哪個。
 * main（setup.ts setDisplayMediaRequestHandler）現在只在**偵測到 >1 個螢幕**時，透過 IPC 請 renderer
 * 顯示這個 in-app 選擇器（不用 native dialog，符合跨平台統一 UI 原則）；單螢幕維持原本直接授權、不觸發。
 *
 * 掛在 App 根層即可（PWA / iOS / Android 上 `aegisElectron` 不存在 → 永遠不 render，零影響）。
 */

import { useEffect, useState } from 'react';

interface PickReq {
  reqId: string;
  sources: Array<{ id: string; name: string; thumbnail: string }>;
}

export function ScreenSourcePicker() {
  const [req, setReq] = useState<PickReq | null>(null);

  useEffect(() => {
    const api = window.aegisElectron;
    if (!api?.onScreenPickRequest) return; // 非 Electron / 舊殼 → 不啟用
    return api.onScreenPickRequest((reqId, sources) => setReq({ reqId, sources }));
  }, []);

  if (!req) return null;

  const pick = (sourceId: string | null) => {
    window.aegisElectron?.respondScreenPick?.(req.reqId, sourceId);
    setReq(null);
  };

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-4"
      onClick={() => pick(null)}
    >
      <div
        className="bg-surface-secondary rounded-2xl p-5 max-w-2xl w-full shadow-2xl border border-[var(--surface-border)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-on-surface-primary text-base font-medium mb-4">選擇要分享的螢幕</h3>
        <div className="grid grid-cols-2 gap-3 max-h-[60vh] overflow-auto">
          {req.sources.map((s) => (
            <button
              key={s.id}
              onClick={() => pick(s.id)}
              className="flex flex-col items-stretch gap-2 p-2 rounded-lg bg-surface-tertiary border border-[var(--surface-border)] hover:border-mist-400 transition-colors text-left"
            >
              {s.thumbnail ? (
                <img src={s.thumbnail} alt={s.name} className="w-full rounded object-cover bg-black" />
              ) : (
                <div className="w-full aspect-video rounded bg-black flex items-center justify-center text-2xl">🖥️</div>
              )}
              <span className="text-on-surface-secondary text-sm truncate">{s.name}</span>
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={() => pick(null)}
            className="px-4 py-2 rounded-lg bg-surface-elevated hover:bg-surface-elevated text-on-surface-secondary text-sm"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

export default ScreenSourcePicker;
