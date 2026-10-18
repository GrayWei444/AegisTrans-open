# AegisDisplayHelper Build / Sign / Notarize Guide

This file documents how the macOS native helper for AegisDisplay is built, signed,
and notarized for inclusion in the Capacitor Electron `.dmg`.

**Phase 2 §6.2 status (2026-05-10):** Scaffold ready. Real build / sign / notarize
verification waits for the next Mac session.

---

## Prerequisites (on the Mac build server)

| Tool | Version | Notes |
|------|---------|-------|
| Xcode | 26+ | Provides `swift`, `codesign`, `xcrun notarytool` |
| Xcode Command Line Tools | latest | `xcode-select --install` if missing |
| macOS | 12+ | SwiftPM `platforms: [.macOS(.v12)]` minimum |
| Apple Developer Program | active | $99/year, paid 2026-05-09 (per HANDOFF.md) |

Set environment variables in `~/.zprofile` once the certs/profile are exported:

```bash
# Developer ID Application certificate (export from Keychain Access)
export AEGIS_DEVELOPER_ID='Developer ID Application: AegisRD (TEAMID)'

# notarytool keychain profile (created via `xcrun notarytool store-credentials`)
export AEGIS_NOTARIZE_PROFILE='aegis-notarize'
```

To set up the notarytool keychain profile (one-time, needs Apple ID + app-specific
password):

```bash
xcrun notarytool store-credentials aegis-notarize \
  --apple-id <your-apple-id> \
  --team-id <TEAM_ID> \
  --password <app-specific-password>
```

Generate the app-specific password at https://account.apple.com/account/manage
→ Sign-In and Security → App-Specific Passwords. **Do not** use the regular Apple
ID password.

---

## Build pipeline

```bash
# From repo root on the Mac build server:
cd ~/dev/AegisTrans/packages/aegis-display/electron/mac

# Iteration build (debug, unsigned)
./build.sh

# Release for bundling (unsigned — local install only, will hit Gatekeeper)
./build.sh --release

# Release for distribution (signed)
./build.sh --release --sign

# Full pipeline for distribution
./build.sh --release --sign --notarize
```

Output: `dist/AegisDisplayHelper` (single Mach-O CLI binary, ~1-3 MB).

`electron-builder` picks it up via the `extraResources` config in
`packages/pwa/electron/electron-builder.config.json`. After bundling, the helper
sits at `<App>.app/Contents/Resources/AegisDisplayHelper`. The Capacitor Electron
plugin (`packages/aegis-display/electron/src/plugin.ts`) resolves it via
`process.resourcesPath` at runtime.

---

## Verifying the signed binary

```bash
codesign --display --verbose=4 dist/AegisDisplayHelper
codesign --verify --deep --strict --verbose=2 dist/AegisDisplayHelper

# Notarization status (via online lookup since CLI can't be stapled):
spctl --assess --type execute --verbose=4 dist/AegisDisplayHelper
```

`spctl` should report `accepted` once notarization clears (~1-15 minutes).

---

## Phase 2 §6.2 work order (next Mac session)

1. **Bind `CGVirtualDisplayCreate` private API**
   - Copy private header: `cp /System/Library/Frameworks/CoreGraphics.framework/Versions/A/PrivateHeaders/CGVirtualDisplay.h Sources/AegisDisplayHelper/CGVirtualDisplay.h`
   - Reference [BetterDummy](https://github.com/waydabber/BetterDummy) (MIT) for descriptor
     setup pattern: `BetterDummy/Support/DummyManager.swift`
   - Implement `VirtualDisplayManager.enable()` + `.disable()` in
     `Sources/AegisDisplayHelper/VirtualDisplay.swift`
2. **Decide process lifecycle** (see `AegisDisplayHelper/README.md` §"Process lifecycle question")
   - Option A: long-running daemon (state in helper memory)
   - Option B: launchd agent (state survives helper restart)
   - Option C: persist display ref via XPC service to a separate macOS service
3. **Build + sign + notarize end-to-end**
   - `./build.sh --release --sign --notarize` should green
   - `spctl --assess` should report `accepted`
4. **Wire up `electron-builder` extraResources**
   - Already drafted in `packages/pwa/electron/electron-builder.config.json` (see
     `extraResources` entry for AegisDisplayHelper) but not yet tested
5. **Smoke test**
   - From the packaged `.app`: launch AegisTrans → trigger
     `AegisDisplay.enableVirtualDisplay({ resolution: '2560x1440' })` from the
     renderer's UpgradePage / dev console
   - Open System Settings → Displays — should see "AegisDisplay" virtual monitor
6. **Verify ScreenCaptureKit picks it up**
   - In the same renderer, call `AegisDisplay.captureScreen()` → system dialog
     should list "AegisDisplay" as a screen source

---

## Reference

- BetterDummy (forked for the binding): https://github.com/waydabber/BetterDummy
- `xcrun notarytool` docs: `man notarytool`
- Apple's Hardened Runtime entitlements: https://developer.apple.com/documentation/security/hardened_runtime
