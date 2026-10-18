# AegisDisplay-Win Build / Sign Guide

How the Windows native pieces (IddCx driver + control CLI) are built, signed, and
bundled into the Capacitor Electron `.exe`.

**Phase 3 status (2026-05-14):** Scaffold only. No Windows build environment exists
yet — directory structure, build script, and the control-CLI skeleton are laid out
so the next Windows session can fill in the fork + IPC and build immediately.

This mirrors `../mac/BUILD.md` but Windows is a **driver-install** model, not a
spawned-helper model — see `README.md` §"Windows 模型跟 Mac 不一樣".

---

## Prerequisites (on the Windows build machine)

The user is provisioning a Windows machine in the same model as the Mac build
server (Tailscale + SSH, triggered remotely from the VPS). Once it exists:

| Tool | Version | Notes |
|------|---------|-------|
| Windows | 10 22H2 / 11 x64 | IddCx driver needs real Windows — VM is OK, wine/Linux is **not** |
| Visual Studio 2022 | 17.x, "Desktop development with C++" workload | provides `msbuild`, MSVC toolset, CMake |
| Windows Driver Kit (WDK) | matching the installed Windows SDK | provides IddCx headers/libs; itsmikethetech VDD targets **IddCx 1.10** |
| — *or* — EWDK | standalone Enterprise WDK (ISO/zip, no VS install) | alternative if VS is too heavy; `LaunchBuildEnv.cmd` then `msbuild` |
| CMake | 3.20+ | for `AegisDisplayControl/` (VS 2022 bundles it) |

Driver-dev environment (one-time, dev machine only):

```powershell
# Enable test-signing so a non-Microsoft-attested driver can load.
# REQUIRES A REBOOT. Only on the dev machine — never tell end users to do this.
bcdedit /set testsigning on
```

For distribution you need instead:
- **EV code-signing certificate** (~$300-600/yr) — required to access the Microsoft
  Partner Center and to sign the driver submission.
- Driver submitted for **attestation signing** via Partner Center (IddCx UMDF
  drivers qualify for attestation signing; no full WHQL lab testing needed).

---

## Build pipeline

```powershell
# From the win/ folder on the Windows build machine:
cd C:\dev\AegisTrans\packages\aegis-display\electron\win

# Iteration build (debug, unsigned — won't load without testsigning)
.\build.ps1

# Release build (unsigned)
.\build.ps1 -Release

# Release + test-sign (dev machine — loads under `bcdedit /set testsigning on`)
.\build.ps1 -Release -TestSign

# Release + EV sign (distribution; needs AEGIS_EV_CERT_THUMBPRINT env var)
.\build.ps1 -Release -Sign
```

`build.ps1` does, in order:

1. `msbuild` the driver solution in `AegisDisplayDriver/` → `AegisDisplay.dll` +
   `AegisDisplay.inf` + (after signing) `AegisDisplay.cat`.
2. `cmake` configure + build `AegisDisplayControl/` → `AegisDisplayControl.exe`.
3. Stage all artifacts into `win/dist/` (the folder electron-builder bundles).
4. `-TestSign` → generate/reuse a self-signed test cert, `signtool` the `.dll`,
   `inf2cat` + `signtool` the `.cat`, `signtool` the `.exe`.
   `-Sign` → same but with the EV cert (`AEGIS_EV_CERT_THUMBPRINT`); the driver
   `.cat` still needs Partner Center attestation afterwards (not scriptable here).

Output: `win/dist/` containing
```
dist/
├── AegisDisplay.dll          IddCx driver binary
├── AegisDisplay.inf          driver install manifest
├── AegisDisplay.cat          signed catalog (after -TestSign / -Sign + attestation)
└── AegisDisplayControl.exe   control CLI spawned by electron/src/plugin.ts
```

`electron-builder` will pick `win/dist/` up via a `win.extraResources` entry in
`packages/pwa/electron/electron-builder.config.json` — **that entry does not exist
yet**; adding it is work-order item 6 below. After bundling, the artifacts sit at
`<App>\resources\AegisDisplay\` and the Capacitor Electron plugin resolves them
relative to `process.resourcesPath`.

---

## Driver install / uninstall

Not part of `build.ps1` — this is what the **NSIS installer** does at install time
(needs admin; `nsis.allowElevation` is already `true` in the electron-builder config):

```powershell
# install (NSIS installer / dev)
pnputil /add-driver AegisDisplay.inf /install

# uninstall (NSIS uninstaller / dev)
pnputil /delete-driver AegisDisplay.inf /uninstall
```

On a dev machine with test-signing on, you can run those manually to iterate without
rebuilding the `.exe`.

---

## Verifying

```powershell
# driver staged correctly
Get-AuthenticodeSignature dist\AegisDisplay.dll
Get-AuthenticodeSignature dist\AegisDisplay.cat

# driver loaded (after pnputil install)
pnputil /enum-drivers | Select-String AegisDisplay
Get-PnpDevice -Class Display | Where-Object FriendlyName -like '*AegisDisplay*'

# control CLI contract
dist\AegisDisplayControl.exe status
dist\AegisDisplayControl.exe enable --resolution 2560x1440
dist\AegisDisplayControl.exe disable
```

After `enable`, the virtual monitor should appear in Settings → System → Display,
and `getDisplayMedia()` in the Electron renderer should list it as a screen source
(under a generic name — see work-order item 7).

---

## Phase 3 work order (next Windows session)

1. **Confirm the build environment** — Windows machine reachable, VS 2022 + WDK (or
   EWDK) installed, `msbuild` and `cmake` on PATH.
2. **Fork itsmikethetech VDD** into `AegisDisplayDriver/` — see
   `AegisDisplayDriver/README.md` for what to clone, the rename map, and which
   variants to drop.
3. **Rebrand the driver** — virtual monitor name → `AegisDisplay`, lock the
   resolution profile to 1920×1080 / 2560×1440 / 3840×2160, remove the audio driver
   and HDR variant we don't ship.
4. **Wire control CLI ↔ driver IPC** — replace the `notImplemented` stubs in
   `AegisDisplayControl/src/main.cpp` with the real monitor attach/detach calls
   (itsmikethetech VDD's named-pipe / settings mechanism — confirm exact protocol
   after forking).
5. **`build.ps1 -Release -TestSign`** should go green; on the dev machine the driver
   loads and `getDisplayMedia()` sees `AegisDisplay`.
6. **electron-builder `win.extraResources`** — add an entry mirroring the existing
   `mac.extraResources`, pointing at `../../aegis-display/electron/win/dist`.
7. **desktopCapturer naming** — apply the lesson from Mac commit `6a4f46f`: Windows
   `desktopCapturer` names screens generically ("Screen 1/2"), not `AegisDisplay`.
   The renderer must match on `display_id`, not on name. A Windows equivalent of the
   `aegis:displays:get-source-by-display-id` IPC handler will be needed.
8. **plugin.ts win32 branch** — fire-and-forget, **not** a copy of the darwin
   spawn-and-hold branch (see `README.md`).
9. **EV cert + Partner Center attestation** — only for real distribution.

---

## Reference

- itsmikethetech VDD (fork source): https://github.com/itsmikethetech/Virtual-Display-Driver
- IddCx (Indirect Display Driver) docs: https://learn.microsoft.com/windows-hardware/drivers/display/indirect-display-driver-model-overview
- Driver signing / attestation: https://learn.microsoft.com/windows-hardware/drivers/dashboard/attestation-signing
- `pnputil`: https://learn.microsoft.com/windows-hardware/drivers/devtest/pnputil
