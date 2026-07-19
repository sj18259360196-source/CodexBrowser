@echo off
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Codex Browser requires Node.js 22.13 or newer.
  echo Install a current Node.js LTS release, then run this launcher again.
  exit /b 1
)

node scripts\check-node-version.mjs >nul 2>nul
if errorlevel 1 (
  echo Codex Browser requires Node.js 22.13 or newer.
  echo Current version:
  node --version
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  call npm install
  if errorlevel 1 exit /b 1
)

if not exist "dist\electron\main.js" (
  call npm run build
  if errorlevel 1 exit /b 1
)

node scripts\start-runtime.mjs
