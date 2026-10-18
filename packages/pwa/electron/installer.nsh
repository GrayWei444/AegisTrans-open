; AegisTrans NSIS installer hooks — driver install/remove + cert trust
;
; Electron-builder includes this via `nsis.include` config entry. The
; `customInstall` macro runs AFTER electron-builder's default app install
; (after files are copied to $INSTDIR); `customUnInstall` runs BEFORE the
; default app remove.
;
; Resources expected under $INSTDIR\resources\AegisDisplay\ (via win.extraResources):
;   AegisDisplay.inf  — driver install manifest
;   AegisDisplay.dll  — IddCx UMDF driver binary
;   AegisDisplay.cat  — signed driver catalog
;   AegisDisplayControl.exe  — control CLI (spawned by plugin.ts)
;   AegisDisplayTestCert.cer — self-signed code-signing cert (public part only)
;   devcon.exe        — Microsoft device console utility (from WDK Tools)
;
; Cert is added to LocalMachine\Root + LocalMachine\TrustedPublisher so the
; .cat signature is accepted by pnputil. For commercial distribution we'd use
; an EV cert + Microsoft attestation and could skip the cert step entirely.

!macro customInstall
  DetailPrint "==> AegisDisplay driver setup"

  Var /GLOBAL AegisDriverDir
  StrCpy $AegisDriverDir "$INSTDIR\resources\AegisDisplay"

  ; 0. Write monitors-count=0 xml to C:\AegisDisplay\ BEFORE driver loads so the
  ;    upstream default (count=1 = always-on virtual monitor) doesn't activate.
  ;    User must explicitly click 延伸 to get the virtual screen.
  CreateDirectory "C:\AegisDisplay"
  ; Sentinel — proves customInstall ran. Easy to grep after install.
  FileOpen $0 "C:\AegisDisplay\install-sentinel.txt" w
  FileWrite $0 "customInstall ran $\r$\n"
  FileClose $0
  FileOpen $0 "C:\AegisDisplay\vdd_settings.xml" w
  FileWrite $0 "<?xml version='1.0' encoding='utf-8'?>$\r$\n"
  FileWrite $0 "<vdd_settings>$\r$\n"
  FileWrite $0 "    <monitors><count>0</count></monitors>$\r$\n"
  FileWrite $0 "    <gpu><friendlyname>default</friendlyname></gpu>$\r$\n"
  FileWrite $0 "    <global><g_refresh_rate>60</g_refresh_rate></global>$\r$\n"
  FileWrite $0 "    <resolutions>$\r$\n"
  FileWrite $0 "        <resolution><width>1920</width><height>1080</height><refresh_rate>60</refresh_rate></resolution>$\r$\n"
  FileWrite $0 "    </resolutions>$\r$\n"
  FileWrite $0 "    <logging><SendLogsThroughPipe>true</SendLogsThroughPipe><logging>false</logging><debuglogging>false</debuglogging></logging>$\r$\n"
  FileWrite $0 "    <colour><SDR10bit>false</SDR10bit><HDRPlus>false</HDRPlus><ColourFormat>RGB</ColourFormat></colour>$\r$\n"
  FileWrite $0 "</vdd_settings>$\r$\n"
  FileClose $0
  DetailPrint "  wrote default vdd_settings.xml (count=0)"

  ; CR-08：**不再**把自簽憑證塞進 LocalMachine\Root / TrustedPublisher。
  ; 那會改變整台機器的信任根（任何用該私鑰簽的東西都被信任）= 機器層級信任污染，
  ; 公開發行絕對不可。正解是用「真正的 EV 憑證 + Microsoft Partner Center attestation」
  ; 簽 .cat（見 build.ps1 -Sign + BUILD.md）。在那之前驅動安裝會 fail-closed：
  ; 下面的 pnputil /add-driver 對「未被機器信任的目錄簽章」會直接拒絕 → 不裝未信任驅動。
  ; （螢幕「投放/鏡像」不需此驅動仍可用；只有「延伸虛擬螢幕」需要，會在有真憑證前停用。）

  ; 2. Stage driver into driver store (idempotent — re-staging is fine on upgrade)
  ;    僅在 .cat 由「機器已信任的憑證」簽章時才會成功（production EV/attestation 簽）。
  DetailPrint "  pnputil /add-driver AegisDisplay.inf /install..."
  nsExec::ExecToLog '"$SYSDIR\pnputil.exe" /add-driver "$AegisDriverDir\AegisDisplay.inf" /install'
  Pop $0
  DetailPrint "    pnputil exit=$0"

  ; 3. Remove any existing Root\AegisDisplay device nodes BEFORE creating a fresh one.
  ;    devcon `install` is NOT idempotent — re-running it creates a new ROOT\DISPLAY\N
  ;    sibling each time. Without removing first, upgrades pile up phantom devices.
  DetailPrint "  cleaning any pre-existing Root\AegisDisplay devices..."
  nsExec::ExecToLog '"$AegisDriverDir\devcon.exe" remove "Root\AegisDisplay"'
  Pop $0
  DetailPrint "    devcon remove (pre-install) exit=$0"

  ; 4. Create the synthetic Root\AegisDisplay device node (required for root-enumerated drivers)
  DetailPrint "  devcon install Root\AegisDisplay..."
  nsExec::ExecToLog '"$AegisDriverDir\devcon.exe" install "$AegisDriverDir\AegisDisplay.inf" "Root\AegisDisplay"'
  Pop $0
  DetailPrint "    devcon install exit=$0"
!macroend

!macro customUnInstall
  DetailPrint "==> AegisDisplay driver teardown"

  Var /GLOBAL AegisDriverDirUn
  StrCpy $AegisDriverDirUn "$INSTDIR\resources\AegisDisplay"

  ; 1. Remove the device node (must happen before pnputil /delete-driver)
  DetailPrint "  devcon remove Root\AegisDisplay..."
  nsExec::ExecToLog '"$AegisDriverDirUn\devcon.exe" remove "Root\AegisDisplay"'
  Pop $0
  DetailPrint "    devcon remove exit=$0"

  ; 2. Hand off driver-store cleanup to a bundled batch helper (NSIS quoting +
  ;    cmd `for /f` + pnputil grep was unwieldy inline; cleaner as a script).
  DetailPrint "  removing AegisDisplay from driver store..."
  nsExec::ExecToLog 'cmd.exe /c ""$AegisDriverDirUn\aegis-driver-uninstall.cmd""'
  Pop $0
  DetailPrint "    driver-uninstall helper exit=$0"

  ; Note: we intentionally do NOT remove the cert from TrustedRoot/TrustedPublisher —
  ; it's harmless and removing it would break OTHER apps the user might have signed
  ; with the same self-signed approach. Users can manually clean via certlm.msc.
!macroend
