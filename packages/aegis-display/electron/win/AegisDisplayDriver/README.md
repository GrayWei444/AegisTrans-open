# AegisDisplayDriver — IddCx virtual display driver

Forked from [itsmikethetech/Virtual-Display-Driver](https://github.com/itsmikethetech/Virtual-Display-Driver) (MIT).

**Fork point:** upstream commit `052f0aa Fix HDR bit depth for Virtual-Display-Driver` (2026-05-17).
**Upstream LICENSE retained** as `LICENSE.upstream`.

---

## Layout

```
AegisDisplayDriver/
├── README.md                  (this file)
├── LICENSE.upstream           upstream MIT license
├── AegisDisplay.sln           Visual Studio solution (msbuild target)
├── AegisDisplay/              the IddCx driver project
│   ├── AegisDisplay.vcxproj   (.filters, .inf alongside)
│   ├── Driver.cpp / .h        rebranded EVT_IDD_CX_* callbacks
│   ├── Trace.h                WPP tracing
│   └── readme.md              upstream install steps (reference)
├── Common/                    shared headers from upstream
├── ThirdParty/                upstream WDF 2.15 headers (include path target)
├── EDID/                      EDID blobs (upstream — see "EDID" below)
├── GetIddCx/                  IddCx version query helper (upstream)
├── vdd_settings.xml           runtime config — `<monitors><count>` + `<resolutions>`
└── option.txt                 upstream resolution list (not currently consumed)
```

`AegisDisplay/AegisDisplay.vcxproj` references `..\Common\Include` and `..\ThirdParty\Windows-Driver-Frameworks\src\publicinc\wdf\umdf\2.15` — the path was `..\..\` in upstream because of the intermediate `Virtual Display Driver (HDR)/` folder, which we flattened away.

---

## Rebrand summary

| What | upstream | AegisDisplay |
|---|---|---|
| Named pipe (Driver.cpp:47) | `\\.\pipe\MTTVirtualDisplayPipe` | `\\.\pipe\AegisDisplayPipe` |
| Settings dir (Driver.cpp:94) | `C:\VirtualDisplayDriver\` | `C:\AegisDisplay\` |
| Registry key (Driver.cpp:330) | `HKLM\SOFTWARE\MikeTheTech\VirtualDisplayDriver` | `HKLM\SOFTWARE\AegisRD\AegisDisplay` |
| Model name (Driver.cpp:173) | `L"Virtual Display"` | `L"AegisDisplay"` |
| EndPoint names (Driver.cpp:3696-3698) | `"VirtualDisplayDriver Device/Model"` + `"MikeTheTech"` | `"AegisDisplay"` + `"AegisRD"` |
| Project / output names | `MttVDD.{sln,vcxproj,dll,cat,inf}` | `AegisDisplay.*` |
| INF DeviceName | `"Virtual Display Driver"` | `"AegisDisplay"` |
| INF Manufacturer | `MikeTheTech` | `AegisRD` |
| INF hardware ID | `Root\MttVDD`, `MttVDD` | `Root\AegisDisplay`, `AegisDisplay` |
| INF DriverGroupId | `MttVDDGroup` | `AegisDisplayGroup` |

C++ symbol names like `VirtualDisplayDriverDeviceAdd` etc. kept as-is (internal callbacks; not user-visible).

---

## IddCx version

`AegisDisplay.vcxproj` sets `IDDCX_VERSION_MINOR=4` on `Debug|x64` / `Release|x64` (was `10` in upstream HDR config). **WDK 11 (10.1.22000) does not ship IddCx 1.10 headers** — see `[[feedback-windows-build-verify-paths]]`. WDK 22000 provides 1.0 / 1.2 / 1.3 / 1.4 / 1.6 / 1.7 / 1.8; 1.4 is a safe lower bound that keeps the `EvtIddCxParseMonitorDescription2` etc. signatures the driver uses.

The other (unused) configs — Win32 / ARM / ARM64 — are left in the vcxproj untouched; `build.ps1` invokes `Release|x64` only.

INF `UmdfExtensions = IddCx0102` (= runtime bind to extension 1.2) is unchanged — runtime bind vs compile-time MINOR are independent.

---

## EDID

`s_KnownMonitorEdid` (Driver.cpp:281) holds the EDID blob the driver advertises over DDC. Upstream's blob shows generic "Virtual Display" in EDID monitor descriptors. Display friendly name in Windows Settings comes from `modelName` + EndPoint name (already rebranded), so EDID blob is **not on the critical path** for first build. A cleaner DDC monitor name (showing "AegisDisplay" in third-party display-info tools) can be a follow-up — generate a fresh EDID blob and bake it in.

---

## Build / install

See `../BUILD.md`. The `AegisDisplay.sln` is built by `build.ps1` and outputs `AegisDisplay.dll` + `AegisDisplay.cat` + `AegisDisplay.inf` to a target dir that gets staged into `../dist/`.

Driver install/uninstall is via `pnputil` from the NSIS installer (not from `build.ps1` — needs admin). Test-signing on dev machines:

```powershell
bcdedit /set testsigning on   # requires reboot
```

---

## What is **not** committed

- `AegisDisplayDriver/_upstream/` — the upstream clone is throwaway. Re-clone with the command in this README if you need it again.
- Build output: `x64/`, `.vs/`, `*.cat` (signed), `*.dll`, `Debug/`, `Release/` — see `.gitignore` (TODO add).
