/**
 * 螢幕投放 / 延伸 / 停止 的小 icon —「圓潤塗鴉」手繪風(使用者選 B)。
 *
 * 風格:粗圓筆觸 + 圓角 linecap/linejoin + 略帶有機弧線,呼應 logo 的發光粗線條。
 * 顏色靠 currentColor 繼承按鈕文字色(mist-300 idle、red active)。
 * viewBox 48、stroke 4.5 → 在 16px(w-4) 小按鈕上仍保有「粗圓」手感。
 */

interface IconProps {
  className?: string;
}

const COMMON = {
  viewBox: '0 0 48 48',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 4.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** 投放(cast):螢幕 + 左下角廣播波紋(把本機畫面「播」到對方螢幕) */
export function CastIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg {...COMMON} className={className} aria-hidden="true">
      {/* 螢幕(圓潤、左下讓位給波紋) */}
      <path d="M11 15q-1-5 4-4.8l20 .6q4.6.2 3.4 4.8l-1.4 13.6q-.5 3.8-4.6 3.4L22 32.8" />
      {/* 兩道廣播弧 */}
      <path d="M10 25.5q8.5.5 9 11.5" />
      <path d="M10 32q4.3 0 4.8 5.8" />
      {/* 波紋原點 */}
      <circle cx="10" cy="38.4" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 延伸(extend):主螢幕 → 第二螢幕 + 延伸箭頭(本機開虛擬螢幕當對方第二螢幕) */
export function ExtendIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg {...COMMON} className={className} aria-hidden="true">
      {/* 主螢幕(圓潤) */}
      <path d="M6 13.5q-.5-3.2 3-3l14 .3q3.2.2 2.9 3.4L25.5 26q-.3 3.2-3.5 2.9L9 28.6q-3.2.2-3-3.2z" />
      <path d="M12.5 33.5h8.5" />
      <path d="M16.5 28.8v4.7" />
      {/* 第二螢幕(偏右下、半露) */}
      <path d="M32 19.5q-.3-2.3 2.2-2.1l7.4.2q2.4 0 2.2 2.6l-.6 13q-.2 2.5-2.7 2.3L33.5 37" />
      {/* 延伸箭頭 */}
      <path d="M25.5 29.5h8.5m0 0l-3.4-3.2m3.4 3.2l-3.4 3.4" />
    </svg>
  );
}

/** 停止(投放/延伸):圓潤方塊 */
export function StopIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg {...COMMON} className={className} aria-hidden="true">
      <path d="M13 11.5q-2 .3-2 2.3l.4 20.4q0 2 2 1.9l20.4-.4q2 0 1.9-2l-.4-20.4q0-2-2-1.9z" />
    </svg>
  );
}
