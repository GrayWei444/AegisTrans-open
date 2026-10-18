# `@aegisrd/capacitor-aegisdisplay-electron`

Capacitor Electron native bridge for AegisDisplay. **Not** the renderer-side
plugin (that lives at `../src/index.ts`); this is the Electron **main** process
side that gets registered via `setupCapacitorElectronPlugins`.

## Role

Renderer calls `AegisDisplay.enableVirtualDisplay(...)` →
@capacitor-community/electron IPC → main process → `class AegisDisplay` in
`dist/plugin.js` (compiled from `src/plugin.ts`) → `child_process.spawn` of the
Mac `AegisDisplayHelper` Swift CLI → `CGVirtualDisplayCreate` private API.

Diagram:

```
renderer (Chromium)              main (Node)               native helper (Swift)
─────────────────────────────────────────────────────────────────────────────────
AegisDisplay.enableVirtual──IPC──AegisDisplay.enableVirtual──spawn──AegisDisplayHelper
   Display(...)                     Display(opts)                     enable --resolution X
                                       │                                  │
                                       │                                  ↓
                                       │                            CGVirtualDisplayCreate
                                       │                                  │
                                       └─────────JSON over stdout─────────┘
```

`captureScreen` is **NOT** routed here. The renderer-side plugin (`src/index.ts`)
detects `Capacitor.getPlatform() === 'electron'` and routes captureScreen back
to the web fallback — the Chromium renderer's `getDisplayMedia()` works
directly, and `MediaStream` cannot cross IPC boundaries.

## Build

```bash
npm install
npm run build      # tsc → dist/plugin.js + dist/plugin.d.ts
```

`packages/pwa/electron/package.json` references this package via
`file:../../aegis-display/electron`. Running `npm install` in
`packages/pwa/electron` symlinks `node_modules/@aegisrd/capacitor-aegisdisplay-electron`
to here.

## Native helper

See `mac/BUILD.md` for the macOS Swift CLI build / sign / notarize pipeline.
Helper binary path resolution at runtime:

| Mode | Resolved path |
|------|---------------|
| Production (.app bundle) | `<App>.app/Contents/Resources/AegisDisplayHelper` (via electron-builder `extraResources`) |
| Dev (electron-launched from `pwa/electron/`) | `packages/aegis-display/electron/mac/AegisDisplayHelper/.build/release/AegisDisplayHelper` |

If the binary is missing, plugin methods return
`{ supported: false, enabled: false, reason: '...' }` instead of throwing.

## Phase 2 §6.2 status (2026-05-10)

✅ TS bridge structure + JSON RPC contract + path resolution
✅ Swift CLI scaffold (commands wired, `swift build` should pass)
❌ `CGVirtualDisplayCreate` binding — TODO next Mac session, fork BetterDummy

See `mac/BUILD.md` for the work order.
