@echo off
:: AegisTrans driver uninstall helper — bundled into resources\AegisDisplay\
::
:: Removes the Root\AegisDisplay synthetic device and deletes the driver from
:: the Windows driver store. Called by the NSIS uninstaller's customUnInstall
:: macro, but also runnable manually.
::
:: Requires admin (elevation is provided by the NSIS uninstaller; manual
:: invocation must be from an elevated cmd).

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"

echo [AegisDriver] removing device Root\AegisDisplay
"%SCRIPT_DIR%devcon.exe" remove "Root\AegisDisplay"

echo [AegisDriver] looking up driver store OEM name...
:: pnputil /enum-drivers prints blocks like:
::   Published name:  oem146.inf
::   Original name:   aegisdisplay.inf
:: We want the Published name immediately before our Original name.
set "OEM_INF="
for /f "tokens=*" %%L in ('pnputil /enum-drivers') do (
  set "LINE=%%L"
  echo !LINE! | findstr /b /c:"Published" >nul && (
    for /f "tokens=3" %%P in ("!LINE!") do set "PENDING_OEM=%%P"
  )
  echo !LINE! | findstr /i /c:"aegisdisplay.inf" >nul && (
    if not defined OEM_INF set "OEM_INF=!PENDING_OEM!"
  )
)

if defined OEM_INF (
  echo [AegisDriver] deleting driver store entry !OEM_INF!
  pnputil /delete-driver !OEM_INF! /uninstall /force
) else (
  echo [AegisDriver] no aegisdisplay.inf found in driver store ^(already removed^?^)
)

endlocal
