@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
set "REPO_ROOT=%CD%"
set "SERVER_PORT=5566"
set "BROWSER_CACHE=%REPO_ROOT%\.cache\fingerprint-chromium"
set "BROWSER_PATH="

echo [dbapi] Repo root: %REPO_ROOT%

where node >nul 2>nul
if errorlevel 1 (
  echo [dbapi] Node.js is not installed or not in PATH.
  goto :fail
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [dbapi] npm is not installed or not in PATH.
  goto :fail
)

where powershell >nul 2>nul
if errorlevel 1 (
  echo [dbapi] PowerShell is not installed or not in PATH.
  goto :fail
)

if not exist "%REPO_ROOT%\node_modules" (
  echo [dbapi] node_modules not found. Installing dependencies once...
  call npm install
  if errorlevel 1 goto :fail
) else (
  echo [dbapi] Dependencies already installed. Skipping npm install.
)

for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-ChildItem -Path '%BROWSER_CACHE%' -Recurse -Filter chrome.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName; if ($p) { Write-Output $p }"`) do (
  set "BROWSER_PATH=%%I"
)

if not defined BROWSER_PATH (
  echo [dbapi] fingerprint-chromium not found. Downloading on first run...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO_ROOT%\scripts\setup-fingerprint-chromium.ps1"
  if errorlevel 1 goto :fail

  for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-ChildItem -Path '%BROWSER_CACHE%' -Recurse -Filter chrome.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName; if ($p) { Write-Output $p }"`) do (
    set "BROWSER_PATH=%%I"
  )
)

if not defined BROWSER_PATH (
  echo [dbapi] Browser download did not produce chrome.exe under .cache\fingerprint-chromium.
  goto :fail
)

set "FINGERPRINT_CHROMIUM_PATH=%BROWSER_PATH%"
echo [dbapi] Browser: %FINGERPRINT_CHROMIUM_PATH%
echo [dbapi] Starting server on http://127.0.0.1:%SERVER_PORT%/
echo [dbapi] Admin panel: http://127.0.0.1:%SERVER_PORT%/admin
echo [dbapi] Terminal will stay attached to the server process.
echo.

call npm run dev
if errorlevel 1 goto :fail

goto :eof

:fail
echo.
echo [dbapi] Startup failed.
pause
exit /b 1
