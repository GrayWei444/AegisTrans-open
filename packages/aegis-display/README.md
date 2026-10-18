# @aegisrd/capacitor-aegisdisplay

跨平台螢幕擷取 + 虛擬螢幕延伸的 Capacitor plugin,屬於 AegisTrans monorepo。

## 平台支援矩陣

| 平台 | 路徑 | 實作 | Phase |
|---|---|---|---|
| Web / PWA | `src/web.ts` | `navigator.mediaDevices.getDisplayMedia()` 鏡像 fallback | Phase 2 ✅ ship + 2026-05-10 實機驗證 |
| Mac (Electron) | `electron/` (TS bridge) + `electron/mac/AegisDisplayHelper/` (Swift CLI) | Swift FFI fork BetterDummy → `CGVirtualDisplayCreate` 私有 API。spawn helper binary + JSON RPC | Phase 2 ⏳ scaffold(2026-05-10),binding 待 Mac session |
| Windows (Electron) | `electron/win/` | C++ FFI fork itsmikethetech VDD → IddCx driver | Phase 3 |
| Linux (Electron) | — | 不寫 plugin code,文件指引 `apt install evdi-dkms` (DRM/KMS 虛擬 display) | Phase 3 |
| iOS | `ios/` | Swift ReplayKit Capacitor plugin (手機鏡像) | Phase 3 |
| Android | `android/` | Kotlin MediaProjection Capacitor plugin (手機鏡像) | Phase 3 |

## API

```typescript
import { AegisDisplay } from '@aegisrd/capacitor-aegisdisplay';

// 抓螢幕(Web fallback 走 getDisplayMedia,native 走 native API)
const result = await AegisDisplay.captureScreen({ preferredSurface: 'monitor' });
if (result) {
  // result.stream 是 MediaStream,可直接 addTrack 給 RTCPeerConnection
  // result.sourceType: 'mirror' | 'extension' | 'unknown'
  // result.platform: 'web' | 'electron-mac' | 'electron-win' | ...
}

// 啟用虛擬螢幕(Mac/Win 才支援)
const status = await AegisDisplay.getVirtualDisplayStatus();
if (status.supported) {
  await AegisDisplay.enableVirtualDisplay({ resolution: '2560x1440' });
}
```

## 開發階段內部使用

目前(Phase 2)主 plugin(`src/index.ts`)直接吃 source — `package.json` 的 `main` / `types` 指向 source。Vite 直接 bundle TS,不需先 build。

Electron sub-package(`electron/src/plugin.ts`)是 CommonJS 編譯目標,要先 `cd electron && npm install && npm run build` 產出 `electron/dist/plugin.js`,才能讓 `packages/pwa/electron` 的 `electron-plugins.js` require 進去。

Phase 3 要 `npm publish` 給 AegisTalk 共用前再加 `tsc` emit dist/ 給主 plugin,屆時 main 切到 `dist/index.js`。

## Electron 整合(Phase 2 §6.2 scaffold,2026-05-10)

Capacitor Electron 殼透過兩層整合:

1. **TS bridge** — `electron/src/plugin.ts` 編譯成 `electron/dist/plugin.js`(CommonJS),由 `packages/pwa/electron/src/rt/electron-plugins.js` 透過 `require('@aegisrd/capacitor-aegisdisplay-electron')` 載入。Plugin class 名 `AegisDisplay` 跟 renderer `registerPlugin('AegisDisplay', ...)` 對齊。
2. **Native helper** — `electron/mac/AegisDisplayHelper/` Swift Package(SwiftPM)build 出 CLI 二進位,electron-builder `extraResources` 把它複製到 `<App>.app/Contents/Resources/AegisDisplayHelper`。TS bridge 透過 `child_process.spawn` 跑 helper + JSON RPC。

`captureScreen` 在 Electron 平台**不**走 native — `src/index.ts` 偵測 `Capacitor.getPlatform() === 'electron'` 強制 route 回 web fallback,因為 Chromium renderer 直接吃 `getDisplayMedia()`,而且 `MediaStream` 物件不能跨 IPC 序列化。Native impl 只接 `getVirtualDisplayStatus` / `enableVirtualDisplay` / `disableVirtualDisplay`。

詳見 `electron/mac/BUILD.md` build / sign / notarize 流程。

## 與 AegisTrans 的整合

PWA 內 [services/screenShare.ts](../pwa/src/services/screenShare.ts) 不直接呼叫此 plugin — 由 [App.tsx](../pwa/src/App.tsx) 接 `DeviceListSidebar onShareScreen` event 時呼叫 `AegisDisplay.captureScreen()`,再把 `result.stream` 傳給 `screenShareService.startSharing(stream, peerPubkey)`。

## License

MIT — 與 AegisTrans 相同（見 repo 根目錄 `LICENSE`）；vendored 第三方程式碼的授權見 `THIRD_PARTY_NOTICES.md`。
