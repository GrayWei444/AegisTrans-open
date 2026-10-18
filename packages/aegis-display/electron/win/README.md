# Windows Electron native impl — Phase 3 ⏳ scaffold (2026-05-14)

Windows 桌面延伸 = 給 Windows「加」一個虛擬螢幕，瀏覽器 / Capacitor Electron 殼的
`getDisplayMedia()` 就能抓它當 cast 來源（延伸，不只鏡像）。

對應 Mac 的 `electron/mac/`，但 **Windows 是完全不同的模型**（見下方）。

C++ IddCx (Indirect Display Driver) 驅動，fork
[itsmikethetech/Virtual-Display-Driver](https://github.com/itsmikethetech/Virtual-Display-Driver)（MIT）。

虛擬螢幕命名固定為 `AegisDisplay`。
解析度 profile：1920×1080 / 2560×1440 / 3840×2160。

---

## ⚠️ Windows 模型跟 Mac 不一樣（給之後接 plugin.ts win32 分支的人）

| | Mac (`electron/mac/`) | Windows (`electron/win/`) |
|---|---|---|
| 虛擬螢幕怎麼活著 | `AegisDisplayHelper` process 的 ARC strong ref，**process 死 = 螢幕消失** | 已安裝的 **IddCx 驅動**裡，驅動是系統的一部分，跟任何 process 無關 |
| 要不要先安裝 | 不用，spawn helper 即用 | **要**。一次性 admin 安裝驅動（NSIS 安裝程式跑 `pnputil`），之後才能用 |
| `enable` 做什麼 | spawn helper，helper block 在 semaphore 直到 SIGTERM | spawn `AegisDisplayControl.exe enable`，**立刻回傳**，monitor 掛在驅動裡持續存在 |
| `disable` 做什麼 | SIGTERM 給 stored helper PID | spawn `AegisDisplayControl.exe disable`，叫驅動 detach monitor |
| plugin.ts 要不要追 PID | 要（`activeHelper`）| **不要**。沒有 long-lived process 可追，status 直接問驅動 |
| orphan 問題 | hard crash → helper orphan（`reapOrphanHelpers()`）| 不存在這問題 — 沒有 helper process。但反過來：app 沒移除前驅動一直在 |

**重點：** `electron/src/plugin.ts` 的 win32 分支**不能照抄 darwin 分支**。darwin 分支
spawn-and-hold + 追 `activeHelper` PID 的整套邏輯在 Windows 是錯的。Windows 是
fire-and-forget：每個 method spawn 一次 `AegisDisplayControl.exe`，拿 JSON，結束。

---

## 結構（scaffold ready）

```
electron/win/
├── README.md                    (這個檔)
├── BUILD.md                     Build / sign 完整流程 + 下個 Windows session 工作order
├── build.ps1                    Windows only — msbuild 驅動 + cmake 控制 CLI + 簽章 + stage 到 dist/
├── AegisDisplayDriver/          IddCx UMDF 驅動 — fork itsmikethetech VDD 放這裡
│   └── README.md                fork 指引 + rename map + 預期檔案結構
└── AegisDisplayControl/         控制 CLI — Electron plugin spawn 它來 enable/disable/status
    ├── README.md                CLI contract + 跟驅動的 IPC 設計
    ├── CMakeLists.txt           VS 2022 / cmake build 設定
    └── src/main.cpp             CLI entry + subcommand dispatch + JSON 輸出（驅動 IPC 部分是 stub）
```

`AegisDisplayDriver/` 目前只有 README — 真正的驅動 source 是 fork itsmikethetech
VDD（見 `AegisDisplayDriver/README.md`），fork 動作建議在 Windows build 機器上做，
因為要立刻能 `msbuild` 驗證。

---

## CLI contract（由 TS bridge `../src/plugin.ts` 的 win32 分支 spawn）

跟 Mac `AegisDisplayHelper` **相同的 JSON 介面**，差別只在 `enable` 不 block：

```
AegisDisplayControl.exe status                              → JSON status，exit 0
AegisDisplayControl.exe enable --resolution 2560x1440       → JSON status，exit 0（立刻回，不 block）
AegisDisplayControl.exe disable                             → JSON status，exit 0
```

JSON schema（跟 `src/index.ts` 的 `VirtualDisplayStatus` 對齊）：

```json
{ "supported": true, "enabled": true, "displayId": "...", "resolution": "2560x1440" }
```

驅動沒安裝時 `status` 回 `{ "supported": false, "enabled": false, "reason": "driver not installed" }`。

---

## 驅動安裝 / 移除（不在 CLI contract 裡 — 要 admin）

驅動的安裝 / 移除需要系統管理員權限，**不是** runtime 的 enable/disable：

- **安裝**：NSIS 安裝程式（`packages/pwa/electron` 的 electron-builder `nsis` target）
  在安裝時用 `pnputil /add-driver AegisDisplay.inf /install` 載入驅動。`nsis.allowElevation`
  已開（見 `electron-builder.config.json`）。
- **移除**：解除安裝 AegisTrans 時 `pnputil /delete-driver AegisDisplay.inf /uninstall`。
- **開發機**：`build.ps1 -TestSign` 會 test-sign 驅動 + 開 testsigning 模式，方便不買 EV
  cert 就能在自己的開發 Windows 上 load 驅動 iterate。

---

## 簽章

- **驅動**：IddCx UMDF 驅動要過 Microsoft attestation signing（Partner Center 提交）才能在
  非 testsigning 的 Windows 上 load。要 EV code-signing cert（~$300-600/年）才能進 Partner Center。
- **`.exe` / 控制 CLI / Electron 殼**：EV cert `signtool` 直接簽。
- **永遠不上 Microsoft Store** — driver-level admin install 跟 Store 流程衝突；走自家網站
  `.exe` 分發。
- 詳細流程見 `BUILD.md`。

---

## 下個 Windows session 工作

動工前必讀：`BUILD.md` §work order、`AegisDisplayDriver/README.md`、HANDOFF.md、
專案 CLAUDE.md 第零守則、ARCHITECTURE.md §Phase 2/3。

1. **先確認 build 環境** — Windows 機器（使用者要架，比照 Mac 的 Tailscale + SSH 模式）
   裝 VS 2022 + WDK 或 EWDK，`msbuild` / `cmake` 能跑。
2. **fork itsmikethetech VDD** 進 `AegisDisplayDriver/`（見該資料夾 README）。
3. **rename + 改造** — 虛擬螢幕名改 `AegisDisplay`、解析度 profile 鎖三個、砍掉用不到的
   audio driver / HDR 變體。
4. **接 control CLI ↔ 驅動 IPC** — `AegisDisplayControl/src/main.cpp` 的 stub 換成真的
   named pipe 呼叫（itsmikethetech VDD 的 monitor attach/detach 機制，fork 後確認）。
5. **build + test-sign** — `build.ps1 -Release -TestSign` 應該綠，開發機能 load 驅動、
   `getDisplayMedia()` 看得到 `AegisDisplay`。
6. **electron-builder `win.extraResources`** — 把 `dist/` 打包進 `.exe`（`electron-builder.config.json`
   要加 `win.extraResources`，比照現有的 `mac.extraResources`）。
7. **desktopCapturer 命名問題** — 比照 Mac commit `6a4f46f`：Windows desktopCapturer 也是
   把螢幕命名「Screen 1/2」不是 `AegisDisplay`，所以 renderer 要走 `display_id` 對應，
   不能 name match。
8. **EV cert + attestation signing** — 要正式分發才做。
