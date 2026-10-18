# Mac Electron native impl — Phase 2 ⏳ scaffold(2026-05-10)

Swift CLI helper(SwiftPM)+ TS bridge 走 child_process spawn JSON RPC,fork
[BetterDummy](https://github.com/waydabber/BetterDummy) → `CGVirtualDisplayCreate`
私有 API 建虛擬監視器。

虛擬螢幕命名固定為 `AegisDisplay`,瀏覽器 / Capacitor 殼的 `getDisplayMedia()`
彈出選擇器時使用者可一眼辨識。

解析度 profile:1920×1080 / 2560×1440 / 3840×2160(高 DPI 延伸用)。

## 結構(scaffold ready)

```
electron/mac/
├── README.md                       (這個檔)
├── BUILD.md                        Build / sign / notarize 完整流程
├── build.sh                        macOS only — swift build + codesign + notarytool
├── AegisDisplayHelper.entitlements  Hardened Runtime + library validation
└── AegisDisplayHelper/             SwiftPM package
    ├── Package.swift               targets: AegisDisplayHelper executable
    ├── README.md
    └── Sources/AegisDisplayHelper/
        ├── main.swift              CLI entry + JSON RPC dispatch
        ├── VirtualDisplay.swift    CGVirtualDisplay wrapper(scaffold:enable/disable throw notImplemented)
        └── CGVirtualDisplay.h      Private API forward decl placeholder
```

## CLI contract(由 TS bridge `../src/plugin.ts` spawn)

```
./AegisDisplayHelper status                              → JSON status
./AegisDisplayHelper enable --resolution 2560x1440        → JSON status
./AegisDisplayHelper disable                              → JSON status
```

## 簽章

- Apple Developer ID + Notarization($99/年 Apple Developer Program 已付款,2026-05-09)
- **永遠不上 Mac App Store** — `CGVirtualDisplayCreate` 是私有 API,審核 trigger;走自家網站 .dmg 分發
- `build.sh --release --sign --notarize` 一條命令完整 pipeline,環境變數
  `AEGIS_DEVELOPER_ID` / `AEGIS_NOTARIZE_PROFILE` 設定詳見 BUILD.md

## 下個 Mac session 工作

1. **fork BetterDummy** — 把 `CGVirtualDisplay.h` 真正的 forward decls 補進 placeholder
2. **接 enable/disable** — 在 `VirtualDisplay.swift` 把 `notImplemented` throw 換成真呼叫
3. **驗證 process lifecycle** — 決定走 long-running daemon 還是 launchd agent
   (詳見 `AegisDisplayHelper/README.md` §"Process lifecycle question")
4. **build + sign + notarize end-to-end** — `./build.sh --release --sign --notarize`
5. **smoke test** — `electron-builder` 包進 .dmg → 安裝 → renderer 呼叫
   `AegisDisplay.enableVirtualDisplay({ resolution: '2560x1440' })` →
   System Settings → Displays 應看到 "AegisDisplay"
