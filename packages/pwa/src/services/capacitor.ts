import { Capacitor } from '@capacitor/core';

/**
 * Capacitor 平台偵測 helper（AegisTrans 精簡版）
 *
 * AegisTrans 不需要原生 push / haptics / camera / biometric 等功能：
 * - 不做推播（CLAUDE.md：不是聊天軟體）
 * - 不做視訊/語音通話（自己對自己工具）
 * - 不做 face/biometric unlock（v1 用 password / magic link）
 *
 * 這個檔案只保留純粹的平台判斷，給其他 service 走 native vs web 分支用。
 */

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export function getPlatform(): 'ios' | 'android' | 'web' {
  return Capacitor.getPlatform() as 'ios' | 'android' | 'web';
}

export function isIOS(): boolean {
  return getPlatform() === 'ios';
}

export function isAndroid(): boolean {
  return getPlatform() === 'android';
}

// ============================================
// 狀態列服務（抄自 AegisTalk capacitor.ts，第零守則）
// ============================================

export interface StatusBarOptions {
  style?: 'dark' | 'light';
  backgroundColor?: string;
}

/** 設定狀態列。
 *  AegisTrans 用 overlay:true（跟 AegisTalk 的 false 不同）— 因為 AegisTrans 的 header
 *  用 `.safe-area-top`(padding-top: env(safe-area-inset-top))做頂部留白。overlay:true 時
 *  WebView 滿版、env() 才會回真正的 notch inset(~47px)把 header 推到瀏海下方、頂部無縫深藍；
 *  overlay:false 會讓 env()=0 → safe-area-top 失效 → 內容貼著狀態列(太高)。 */
export async function setStatusBar(options: StatusBarOptions): Promise<void> {
  if (!isNativeApp()) return;
  const { StatusBar, Style } = await import('@capacitor/status-bar');
  try {
    await StatusBar.setOverlaysWebView({ overlay: true });
    if (options.style) {
      await StatusBar.setStyle({
        style: options.style === 'dark' ? Style.Dark : Style.Light,
      });
    }
    if (options.backgroundColor && isAndroid()) {
      await StatusBar.setBackgroundColor({ color: options.backgroundColor });
    }
  } catch (err) {
    console.error('[Capacitor] StatusBar error:', err);
  }
}
