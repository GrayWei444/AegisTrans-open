/**
 * useIsDesktop — 判斷視窗寬度是否 >= sm breakpoint (640px)
 * 用來在 App layout 上只渲染桌面 OR 手機版本（避免 DOM 重複）
 */

import { useEffect, useState } from 'react';

const BREAKPOINT = 640;

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= BREAKPOINT : true
  );

  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return isDesktop;
}
