#requires -Version 5.1
<#
.SYNOPSIS
  Build, sign, and stage the AegisDisplay-Win native pieces (IddCx driver +
  control CLI) for inclusion in the Capacitor Electron .exe.

.DESCRIPTION
  Mirrors ../mac/build.sh. Windows is a driver-install model, not a spawned-helper
  model — see README.md.

  Output: dist\  containing AegisDisplay.dll / .inf / .cat + AegisDisplayControl.exe
  electron-builder picks dist\ up via a win.extraResources entry (TODO: not added
  to electron-builder.config.json yet — see BUILD.md work-order item 6).

.PARAMETER Release
  Build Release config instead of Debug.

.PARAMETER TestSign
  Sign the driver/.cat/.exe with a self-signed TEST certificate. The driver only
  loads on a machine with `bcdedit /set testsigning on`. Dev machines only.

.PARAMETER Sign
  Sign with the EV code-signing certificate identified by the
  AEGIS_EV_CERT_THUMBPRINT environment variable. The driver .cat still needs
  Microsoft Partner Center attestation afterwards (not scriptable here).

.EXAMPLE
  .\build.ps1                       # debug, unsigned
  .\build.ps1 -Release              # release, unsigned
  .\build.ps1 -Release -TestSign    # release + self-signed test cert (dev)
  .\build.ps1 -Release -Sign        # release + EV cert (distribution)

.NOTES
  Phase 3 (2026-05-17): UNTESTED on real Windows build env. Driver forked + rebranded
  from itsmikethetech VDD; AegisDisplayControl IPC implemented. First real build
  pending — when it lands, paths below may need adjusting.
#>
[CmdletBinding()]
param(
  [switch]$Release,
  [switch]$TestSign,
  [switch]$Sign
)

$ErrorActionPreference = 'Stop'

# --- Args / config -----------------------------------------------------------
$Config   = if ($Release) { 'Release' } else { 'Debug' }
$Platform = 'x64'

if ($TestSign -and $Sign) {
  throw 'Use either -TestSign or -Sign, not both.'
}

# --- Paths -------------------------------------------------------------------
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$DriverDir   = Join-Path $ScriptDir 'AegisDisplayDriver'
$ControlDir  = Join-Path $ScriptDir 'AegisDisplayControl'
$DistDir     = Join-Path $ScriptDir 'dist'

# Solution lives at the top of the forked driver dir; the project itself is at
# AegisDisplayDriver\AegisDisplay\AegisDisplay.vcxproj (sibling subfolder).
$DriverSln   = Join-Path $DriverDir 'AegisDisplay.sln'

# --- Sanity checks -----------------------------------------------------------
if ($env:OS -ne 'Windows_NT') {
  throw 'build.ps1 must run on Windows.'
}
foreach ($tool in 'msbuild', 'cmake') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool not found on PATH. Open a 'Developer PowerShell for VS 2022' (or EWDK LaunchBuildEnv.cmd) and re-run."
  }
}

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

# --- 1. Build the IddCx driver -----------------------------------------------
Write-Host "==> msbuild driver ($Config|$Platform)"
if (-not (Test-Path $DriverSln)) {
  throw "Driver solution not found at $DriverSln. Fork itsmikethetech VDD into AegisDisplayDriver/ first (see AegisDisplayDriver/README.md)."
}
& msbuild $DriverSln /p:Configuration=$Config /p:Platform=$Platform /p:SpectreMitigation=false /p:Driver_SpectreMitigation=false /m /nologo
if ($LASTEXITCODE -ne 0) { throw "driver msbuild failed ($LASTEXITCODE)" }

# Driver build output lands at sln-level $DriverDir\$Platform\$Config (msbuild's
# solution-output convention). The .cat lands in a sibling AegisDisplay\ subfolder.
$DriverOut = Join-Path $DriverDir "$Platform\$Config"
foreach ($f in 'AegisDisplay.dll', 'AegisDisplay.inf') {
  $src = Join-Path $DriverOut $f
  if (-not (Test-Path $src)) { throw "expected driver artifact missing: $src" }
  Copy-Item $src (Join-Path $DistDir $f) -Force
}
# .cat is created (signed) only when /TestSign or /Sign is set; copy if present.
$catSrc = Join-Path $DriverOut 'AegisDisplay\aegisdisplay.cat'
if (Test-Path $catSrc) {
  Copy-Item $catSrc (Join-Path $DistDir 'AegisDisplay.cat') -Force
  Write-Host "==> driver + .cat staged to $DistDir"
} else {
  Write-Host "==> driver (unsigned, no .cat) staged to $DistDir"
}

# --- 2. Build the control CLI ------------------------------------------------
Write-Host "==> cmake build AegisDisplayControl ($Config)"
$ControlBuild = Join-Path $ControlDir 'build'
& cmake -S $ControlDir -B $ControlBuild -A $Platform
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed ($LASTEXITCODE)" }
& cmake --build $ControlBuild --config $Config
if ($LASTEXITCODE -ne 0) { throw "cmake build failed ($LASTEXITCODE)" }

$ControlExe = Join-Path $ControlBuild "$Config\AegisDisplayControl.exe"
if (-not (Test-Path $ControlExe)) { throw "control CLI not built: $ControlExe" }
Copy-Item $ControlExe (Join-Path $DistDir 'AegisDisplayControl.exe') -Force
Write-Host "==> control CLI staged to $DistDir"

# --- 3. Sign (optional) ------------------------------------------------------
function Invoke-SignTool([string[]]$Files, [string[]]$Args) {
  $signtool = Get-Command signtool -ErrorAction SilentlyContinue
  if (-not $signtool) { throw 'signtool not found — install the Windows SDK.' }
  & $signtool.Source sign @Args /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 @Files
  if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)" }
}

if ($TestSign) {
  Write-Host '==> test-sign with self-signed certificate (dev only)'
  # TODO (next Windows session):
  #   1. New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=AegisDisplay Test'
  #      ... -CertStoreLocation Cert:\CurrentUser\My  (reuse if it already exists)
  #   2. inf2cat /driver:dist /os:10_X64  -> produces AegisDisplay.cat
  #   3. Invoke-SignTool on dist\AegisDisplay.dll, dist\AegisDisplay.cat, dist\AegisDisplayControl.exe
  #      using /sha1 <test cert thumbprint>
  Write-Warning 'TestSign path is a scaffold stub — implement in the next Windows session.'
}
elseif ($Sign) {
  # CR-08：production 簽章 fail-closed。以前這裡只 Write-Warning 就繼續 → 會產出「未簽章」
  # 的 .dll/.cat/.exe 卻當成已簽 → 有可能被打包進公開發行。production 簽章尚未實作
  # （需真 EV 憑證 + Microsoft Partner Center attestation 簽 .cat），所以這裡直接 throw，
  # 讓 release build 不可能靜默 ship 未簽驅動。實作步驟：
  #   1. inf2cat /driver:dist /os:10_X64
  #   2. Invoke-SignTool dist\*.dll dist\*.cat dist\*.exe /sha1 $env:AEGIS_EV_CERT_THUMBPRINT
  #   3. .cat 再送 Partner Center attestation 簽 — 見 BUILD.md
  throw 'CR-08: production code-signing not implemented. A real EV certificate + Microsoft Partner Center attestation are required before -Sign can produce a distributable driver. Refusing to emit unsigned binaries.'
}

# --- Done --------------------------------------------------------------------
Write-Host ''
Write-Host '==> done'
Write-Host "    output: $DistDir"
Write-Host '    next:   electron-builder bundles dist\ via win.extraResources (see BUILD.md item 6)'
