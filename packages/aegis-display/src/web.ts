/**
 * AegisDisplay Web Fallback — Phase 2 v1
 *
 * 跑在：
 *   - 純瀏覽器 PWA
 *   - Capacitor Electron 殼（renderer 是 Chromium，內部 web API 都能用）
 *
 * 不跑在：
 *   - Capacitor iOS / Android（會被 native plugin 覆蓋）
 *
 * 能力：
 *   ✅ captureScreen — 用 navigator.mediaDevices.getDisplayMedia 抓主螢幕或視窗
 *   ❌ enableVirtualDisplay — web 沒這個權限（throw NotSupported）
 *
 * 何時能延伸（不只鏡像）：
 *   使用者裝了 OS 級虛擬螢幕 helper（Mac BetterDummy / Win VDD / Linux evdi）
 *   後，getDisplayMedia 系統 dialog 會多一個「AegisDisplay」選項可選 →
 *   這時 captureScreen 抓到的就是虛擬螢幕內容（延伸）。Web fallback 不
 *   區分鏡像 vs 延伸，sourceType 一律回 'unknown'，由使用者點選螢幕 dialog
 *   時自己決定（標籤上會看到 "AegisDisplay" 字樣）。
 */

import { WebPlugin } from '@capacitor/core';
import type {
  AegisDisplayPlugin,
  CaptureScreenOptions,
  CaptureScreenResult,
  EnableVirtualDisplayOptions,
  VirtualDisplayStatus,
} from './index';

export class AegisDisplayWeb extends WebPlugin implements AegisDisplayPlugin {
  async captureScreen(options?: CaptureScreenOptions): Promise<CaptureScreenResult | null> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('getDisplayMedia not supported in this browser');
    }

    try {
      // 要求高解析度 + 高 frame rate:預設 video:true Chromium 拿很低(常見 640×360 / 5fps)
      // 鏡像螢幕用,設 ideal 1920×1080 30fps,大多裝置都能滿足
      const videoBase: MediaTrackConstraints = {
        width: { ideal: 1920, max: 3840 },
        height: { ideal: 1080, max: 2160 },
        frameRate: { ideal: 30, max: 60 },
      };
      if (options?.preferredSurface) {
        (videoBase as MediaTrackConstraints & { displaySurface?: string }).displaySurface =
          options.preferredSurface;
      }
      const constraints: DisplayMediaStreamOptions = {
        video: videoBase,
        audio: !!options?.audio,
      };
      const stream = await navigator.mediaDevices.getDisplayMedia(constraints);

      // 嘗試判斷 sourceType — 從 video track 的 settings.displaySurface 看
      // monitor → mirror（如果 label 含 "AegisDisplay" → extension）
      // window / browser → 永遠是 mirror（部分視窗）
      let sourceType: CaptureScreenResult['sourceType'] = 'unknown';
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const settings = videoTrack.getSettings() as MediaTrackSettings & { displaySurface?: string };
        const label = videoTrack.label.toLowerCase();
        if (label.includes('aegisdisplay')) {
          sourceType = 'extension';
        } else if (settings.displaySurface === 'monitor' || label.includes('screen')) {
          sourceType = 'mirror';
        } else {
          sourceType = 'mirror';  // window / browser tab 都歸鏡像
        }
      }

      return {
        stream,
        sourceType,
        platform: detectPlatform(),
      };
    } catch (err) {
      // user 在系統 dialog 取消 → DOMException NotAllowedError / AbortError
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'AbortError') {
        return null;
      }
      throw err;
    }
  }

  async getVirtualDisplayStatus(): Promise<VirtualDisplayStatus> {
    // Web fallback 永遠回 supported=false，因為瀏覽器 / Electron renderer 都不能直接建虛擬螢幕
    // （即使在 Electron Mac 殼跑，要透過 native plugin 才能呼叫 CGVirtualDisplayCreate）
    return {
      supported: false,
      enabled: false,
      reason: 'Virtual display requires native helper. Install AegisTrans desktop app or AegisDisplay helper to enable.',
    };
  }

  async enableVirtualDisplay(_options: EnableVirtualDisplayOptions): Promise<VirtualDisplayStatus> {
    throw new Error('enableVirtualDisplay not supported in web fallback. Install native AegisDisplay helper.');
  }

  async disableVirtualDisplay(): Promise<VirtualDisplayStatus> {
    return this.getVirtualDisplayStatus();
  }
}

function detectPlatform(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent || '';
  // Capacitor Electron renderer 會帶 "Electron" 在 UA
  const isElectron = ua.includes('Electron');
  if (isElectron) {
    if (/Mac OS X|Macintosh/i.test(ua)) return 'electron-mac';
    if (/Windows NT/i.test(ua)) return 'electron-win';
    if (/Linux/i.test(ua)) return 'electron-linux';
    return 'electron-unknown';
  }
  return 'web';
}
