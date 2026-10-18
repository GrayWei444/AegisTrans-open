/**
 * AegisDisplay Capacitor Plugin
 *
 * 跨裝置螢幕分享 / 桌面延伸的平台抽象層。
 *
 * 設計：「同一份 React 程式碼，多平台殼，每殼有自己的 native plugin 實作」
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │ TS 介面（這個檔）                                     │
 *   │   captureScreen()  — 取得 MediaStream                │
 *   │   enableVirtualDisplay() — Mac/Win 啟用虛擬螢幕      │
 *   │   isVirtualDisplaySupported() — 偵測 helper           │
 *   └──────┬──────────────────────────────────────────────┘
 *          │
 *   ┌──────┴──────────────────────────────────────────────┐
 *   │ Web fallback（瀏覽器 / Capacitor Electron 殼）         │
 *   │   navigator.mediaDevices.getDisplayMedia()           │
 *   │   能抓主螢幕（鏡像）或虛擬螢幕（如果 helper 已安裝）   │
 *   └─────────────────────────────────────────────────────┘
 *          │
 *   ┌──────┴──────────────────────────────────────────────┐
 *   │ Native impl（之後在對應 OS 機器上 build）             │
 *   │   ios/        — ReplayKit (Phase 3，手機鏡像)         │
 *   │   android/    — MediaProjection (Phase 3，手機鏡像)   │
 *   │   electron/mac/ — Swift FFI fork BetterDummy         │
 *   │                  (Phase 2，CGVirtualDisplayCreate)   │
 *   │   electron/win/ — C++ FFI fork itsmikethetech VDD    │
 *   │                  (Phase 3，IddCx driver)             │
 *   └─────────────────────────────────────────────────────┘
 *
 * Linux 桌面延伸：不寫 plugin，使用者 `apt install evdi-dkms` 後
 * web fallback 的 getDisplayMedia 自動看到虛擬螢幕（DRM/KMS 層）。
 */

import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { AegisDisplayWeb } from './web';

export type DisplayResolution = '1920x1080' | '2560x1440' | '3840x2160';

export interface CaptureScreenOptions {
  /** 提示偏好（不保證生效，OS dialog 仍會讓使用者選）*/
  preferredSurface?: 'monitor' | 'window' | 'browser';
  /** 是否同時抓系統音訊（多數平台不支援，預設 false） */
  audio?: boolean;
}

/**
 * 抓螢幕的回傳。stream.id 用於後續去重 / lifecycle 偵測。
 */
export interface CaptureScreenResult {
  /** WebRTC-compatible MediaStream，可直接 addTrack 給 RTCPeerConnection */
  stream: MediaStream;
  /** 來源類型：'mirror' = 主螢幕鏡像；'extension' = AegisDisplay 虛擬螢幕延伸；'unknown' = 無法判斷 */
  sourceType: 'mirror' | 'extension' | 'unknown';
  /** 平台：'web' / 'electron-mac' / 'electron-win' / 'ios' / 'android' / 'electron-linux' */
  platform: string;
}

export interface VirtualDisplayStatus {
  /** 此平台是否能用 helper 建虛擬螢幕（Mac/Win 才 true；iOS/Android/Linux/Web 都 false）*/
  supported: boolean;
  /** 目前是否已啟用虛擬螢幕 */
  enabled: boolean;
  /** 若 supported=false，說明原因（給 UI 顯示） */
  reason?: string;
  /** 啟用中的解析度（enabled=true 才有意義） */
  resolution?: DisplayResolution;
  /** 系統 CGDirectDisplayID(hex 字串,enabled=true 才有意義) */
  displayId?: string;
}

export interface EnableVirtualDisplayOptions {
  resolution: DisplayResolution;
}

/**
 * AegisDisplay plugin 介面 — 跨平台 implementation contract。
 */
export interface AegisDisplayPlugin {
  /**
   * 抓螢幕。Web / Electron → getDisplayMedia；iOS → ReplayKit；Android → MediaProjection。
   *
   * 必須由 user gesture 觸發（瀏覽器 / OS 限制）。在 click handler / async chain 第一個
   * await 之前呼叫，否則 NotAllowedError。
   *
   * 使用者取消選擇 → 回傳 null（不 throw）。其他錯誤才 throw。
   */
  captureScreen(options?: CaptureScreenOptions): Promise<CaptureScreenResult | null>;

  /**
   * 查詢虛擬螢幕 helper 狀態。Mac/Win 才會回 supported=true。
   */
  getVirtualDisplayStatus(): Promise<VirtualDisplayStatus>;

  /**
   * 啟用虛擬螢幕（Mac/Win helper）。
   *
   * Mac：呼叫 CGVirtualDisplayCreate（私有 API）建虛擬監視器。
   * Win：透過 IddCx driver 註冊虛擬 display。
   * 不支援的平台：throw Error('Not supported on this platform').
   */
  enableVirtualDisplay(options: EnableVirtualDisplayOptions): Promise<VirtualDisplayStatus>;

  /**
   * 停用虛擬螢幕。
   */
  disableVirtualDisplay(): Promise<VirtualDisplayStatus>;
}

// ============================================================
// 行動端原生螢幕「發送」(投放) — iOS Broadcast Extension / Android MediaProjection
// ============================================================
//
// 桌面/web 的螢幕投放走 captureScreen() → JS getDisplayMedia → JS PeerConnection。
// 行動端不行(WebView 不能把原生螢幕擷取注入 JS PC),所以螢幕 video 的 RTCPeerConnection
// 跑在原生(iOS 在 Broadcast Extension 進程,Android 在 MediaProjection service)。
//
// 信令分工:JS 只管 MQTT + group key 加密;原生只管擷取 + media transport。
// 原生「產生」SDP offer / ICE → 經 plugin event 丟給 JS → JS 經 MQTT 發給接收端;
// JS 收到 answer / remote ICE → 經 plugin method 餵回原生套用。原生不碰 MQTT。
//
// 這層介面 iOS / Android **共用**(只有底層擷取來源不同),所以 nativeScreenSender.ts
// 的 JS 控制器兩平台通用。

export interface ScreenSendStartOptions {
  /** 接收端 device 的 pubkey(base64)。原生只當不透明字串原樣回傳給 JS,不解析。 */
  peerPubkey: string;
}

/** 原生 → JS：本機 SDP（offer/answer），JS 要經 MQTT 轉給接收端 */
export interface ScreenSendSdp {
  sdp: string;
  type: 'offer' | 'answer';
}

/** 原生 ↔ JS：trickle ICE candidate（RTCIceCandidateInit 子集） */
export interface ScreenSendIce {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/** 原生 → JS：投放連線狀態，驅動 iOS/Android「投放中」UI + 失敗回收 */
export interface ScreenSendStateEvent {
  state: 'starting' | 'connecting' | 'connected' | 'failed' | 'ended';
  detail?: string;
}

/**
 * 行動端原生螢幕發送 plugin 介面（與 AegisDisplay 同一個 native plugin，不同 typed view）。
 * 只在 iOS / Android 有原生實作；web / electron 不支援（會 throw）。
 */
export interface AegisScreenSendPlugin {
  /** 開始投放：原生啟動螢幕擷取 + 建 native PC + 產生 offer(經事件丟出) */
  startScreenSend(options: ScreenSendStartOptions): Promise<void>;
  /** JS 收到接收端的 answer → 餵回原生套用 */
  setScreenSendRemoteDescription(options: ScreenSendSdp): Promise<void>;
  /** JS 收到接收端的 trickle ICE → 餵回原生套用 */
  addScreenSendIceCandidate(options: ScreenSendIce): Promise<void>;
  /** 停止投放：停擷取 + 關 native PC */
  stopScreenSend(): Promise<void>;

  addListener(
    eventName: 'screenSendLocalDescription',
    listenerFunc: (event: ScreenSendSdp) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'screenSendIceCandidate',
    listenerFunc: (event: ScreenSendIce) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'screenSendState',
    listenerFunc: (event: ScreenSendStateEvent) => void,
  ): Promise<PluginListenerHandle>;
}

/**
 * Capacitor `registerPlugin` 提供 web fallback；native bundle 載入時會被 native impl 覆蓋。
 *
 * Phase 2:iOS / Android 仍走 web fallback;electron Mac 接上 native impl(electron/src/plugin.ts)
 * Phase 3:iOS / Android / electron Win 各自填 native impl
 *
 * **Capacitor Electron quirk (2026-05-12 抓到):**
 *   `@capacitor-community/electron` 在 renderer 透過 `contextBridge.exposeInMainWorld(
 *   'CapacitorCustomPlatform', { plugins })` 暴露 native plugin proxies。但是
 *   Capacitor 的 `registerPlugin` 不會自動讀 `CapacitorCustomPlatform.plugins`
 *   (依 capacitor core 版本而定,我們這版不認),所以 native impl 永遠不被 routing,
 *   全部 method 落回 web fallback → `AegisDisplayWeb` → `supported: false`。
 *   解法:手動先檢查 `window.CapacitorCustomPlatform.plugins.AegisDisplay`,有就
 *   直接用 native bridge,沒才走 registerPlugin。
 */
function resolveNativeAegisDisplay(): AegisDisplayPlugin {
  // Capacitor Electron native bridge — 直接吃 contextBridge expose 的 proxy
  if (typeof window !== 'undefined') {
    const customPlatform = (window as unknown as {
      CapacitorCustomPlatform?: {
        name?: string;
        plugins?: Record<string, AegisDisplayPlugin | undefined>;
      };
    }).CapacitorCustomPlatform;
    const nativeProxy = customPlatform?.plugins?.AegisDisplay;
    if (nativeProxy) {
      return nativeProxy;
    }
  }
  // Fallback:Capacitor 標準 plugin proxy(iOS / Android / 純 web 走這條)
  return registerPlugin<AegisDisplayPlugin>('AegisDisplay', {
    web: () => new AegisDisplayWeb(),
  });
}

const NativeAegisDisplay = resolveNativeAegisDisplay();

/**
 * captureScreen 在 Electron 必須在 **renderer** 跑(getDisplayMedia 是 Chromium API,
 * 而且回傳的 `MediaStream` 物件不能跨 IPC 序列化送回 renderer)。所以在 Electron 平台
 * 把 captureScreen 強制 route 回 web fallback;getVirtualDisplayStatus /
 * enableVirtualDisplay / disableVirtualDisplay 才走 native(electron/src/plugin.ts
 * 透過 spawn AegisDisplayHelper 二進位呼叫 CGVirtualDisplayCreate 私有 API)。
 *
 * iOS / Android 在 Phase 2 不接 native — 全 method 都走 web fallback。
 */
const webFallbackForCaptureScreen = new AegisDisplayWeb();
const shouldRouteCaptureScreenToWeb = (() => {
  try {
    return Capacitor.getPlatform() === 'electron';
  } catch {
    return false;
  }
})();

export const AegisDisplay: AegisDisplayPlugin = shouldRouteCaptureScreenToWeb
  ? {
      captureScreen: (opts?: CaptureScreenOptions) => webFallbackForCaptureScreen.captureScreen(opts),
      getVirtualDisplayStatus: () => NativeAegisDisplay.getVirtualDisplayStatus(),
      enableVirtualDisplay: (opts: EnableVirtualDisplayOptions) =>
        NativeAegisDisplay.enableVirtualDisplay(opts),
      disableVirtualDisplay: () => NativeAegisDisplay.disableVirtualDisplay(),
    }
  : NativeAegisDisplay;

/**
 * 行動端螢幕發送的 typed view — 與 AegisDisplay 是同一個 native plugin（同名註冊），
 * 只是另一組 typed 介面。不另做 registerPlugin（避免重複註冊警告），直接 cast 同一 proxy。
 * web / electron 上呼叫這些 method 會 reject（native impl 不存在），但 nativeScreenSender.ts
 * 只在 iOS / Android 才用它，所以不會誤呼叫。
 */
export const AegisScreenSend: AegisScreenSendPlugin =
  NativeAegisDisplay as unknown as AegisScreenSendPlugin;

export default AegisDisplay;
