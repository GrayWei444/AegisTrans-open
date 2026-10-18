# AegisDisplayHelper — macOS CLI

Swift Package Manager binary that creates / destroys virtual displays via Apple's
private `CGVirtualDisplayCreate` API. Spawned by the Capacitor Electron main
process (`packages/aegis-display/electron/src/plugin.ts`) over JSON RPC.

## Build (on macOS)

```bash
swift build -c release
# Output: .build/release/AegisDisplayHelper
```

For `electron-builder` packaging, the parent script
`packages/aegis-display/electron/mac/build.sh` handles the full pipeline:
build → sign → notarize → copy into Electron `.app/Contents/Resources/`.

## CLI contract

```bash
./AegisDisplayHelper status
./AegisDisplayHelper enable --resolution 1920x1080|2560x1440|3840x2160
./AegisDisplayHelper disable
```

All commands write JSON to stdout. See `Sources/AegisDisplayHelper/main.swift`
for the contract and `VirtualDisplay.swift` for the result schema.

## Phase 2 §6.2 status

✅ Project structure, JSON CLI contract, Swift skeleton — `swift build` succeeds.
❌ `CGVirtualDisplayCreate` binding — TODO next Mac session, fork
[BetterDummy](https://github.com/waydabber/BetterDummy) (MIT). Specifically:

- `BetterDummy/Support/DummyManager.swift` for descriptor / mode setup
- `/System/Library/Frameworks/CoreGraphics.framework/Versions/A/PrivateHeaders/CGVirtualDisplay.h`
  for forward declarations (copy into `Sources/AegisDisplayHelper/CGVirtualDisplay.h`
  and bridge via SwiftPM `cSettings.headerSearchPath` or `unsafeFlags`)

## Process lifecycle question (open)

Helper currently spawns per-command and exits. A virtual display created in
`enable` is released when the process dies. Two paths:

1. **Long-running daemon** — Electron main starts helper at app launch as a child
   process; helper listens on a socket / stdin loop. Display state persists.
2. **`launchd` agent** — Install helper as a `LaunchAgent` plist that auto-respawns
   when the user logs in. Display persists across app restarts.

Decide based on UX: is the virtual display tied to AegisTrans being open
(option 1) or always present once enabled (option 2)? Phase 2 §6.2 design
notes assume option 1; revisit after dogfooding.
