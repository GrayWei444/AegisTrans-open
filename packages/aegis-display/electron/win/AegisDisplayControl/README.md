# AegisDisplayControl — Windows virtual display control CLI

A small C++ console app that the Capacitor Electron plugin
(`../../src/plugin.ts`, win32 branch) spawns to enable / disable / query the
virtual display. It is the Windows counterpart of the Mac `AegisDisplayHelper`,
but with one fundamental difference (see below).

**Phase 3 status (2026-05-14):** Scaffold. `src/main.cpp` has the full CLI surface
(arg parsing, subcommand dispatch, JSON output) wired up; the three calls into the
driver are `notImplemented` stubs until the driver fork lands.

---

## Why a separate CLI (not Node → driver directly)

- **Parity with Mac** — `plugin.ts` already spawns `AegisDisplayHelper`; spawning
  `AegisDisplayControl.exe` keeps the bridge symmetric.
- **Isolates the driver IPC** — the named-pipe / config protocol is
  itsmikethetech-VDD-specific. A thin C++ shim that owns it is more maintainable
  than reimplementing the pipe protocol in Node.

## CLI contract

Same JSON schema as Mac's `AegisDisplayHelper` (aligns with the
`VirtualDisplayStatus` interface in `../../src/index.ts`):

```
AegisDisplayControl.exe status
  → stdout JSON: { "supported": bool, "enabled": bool, "reason"?: string,
                    "displayId"?: string, "resolution"?: string }
  → exit 0 always (status query never fails)

AegisDisplayControl.exe enable --resolution 2560x1440
  → tells the installed driver to attach a monitor at that resolution
  → stdout JSON status, exit 0
  → RETURNS IMMEDIATELY (see below)

AegisDisplayControl.exe disable
  → tells the driver to detach the monitor
  → stdout JSON status, exit 0
```

Allowed resolutions: `1920x1080`, `2560x1440`, `3840x2160` (validated here AND in
the plugin).

## ⚠️ `enable` does NOT block — unlike Mac

Mac's `AegisDisplayHelper enable` blocks on a semaphore for the helper's lifetime;
the virtual display lives in that process's memory and dies with it.

On Windows the virtual display lives in the **installed driver**, which is part of
the system. `AegisDisplayControl.exe enable` just sends one command to the driver
and exits. There is no long-lived process. Consequences for `plugin.ts`:

- the win32 branch must **not** track a child PID (`activeHelper`)
- `disable` is a fresh `AegisDisplayControl.exe disable` invocation, not a SIGTERM
- `status` asks the driver, it does not read in-process state
- there is no orphan-helper problem and no `reapOrphanHelpers()` equivalent

## Driver dependency

`status` / `enable` / `disable` all require the AegisDisplay driver to be
**installed** (one-time admin step done by the NSIS installer — see `../BUILD.md`).
If the driver is not installed, `status` returns
`{ "supported": false, "enabled": false, "reason": "AegisDisplay driver not installed" }`
and `enable` exits non-zero with a JSON error.

The driver IPC (named pipe vs. config-file-and-reload) is decided when forking
itsmikethetech VDD — see `../AegisDisplayDriver/README.md` §"Runtime monitor
attach/detach". Once known, implement the three `// TODO(driver-ipc)` stubs in
`src/main.cpp`.

## Build

Built by `../build.ps1` (cmake configure + build, staged to `../dist/`). Standalone:

```powershell
cmake -S . -B build -A x64
cmake --build build --config Release
# → build\Release\AegisDisplayControl.exe
```

C++17, Win32 API only, no third-party dependencies.
