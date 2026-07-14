@echo off
setlocal
cd /d "%~dp0.."

if not exist "node_modules\electron\dist\electron.exe" (
  call npm install
  if errorlevel 1 exit /b 1
)

if not exist "dist\electron\main.js" (
  call npm run build
  if errorlevel 1 exit /b 1
)

start "Codex Browser" "node_modules\electron\dist\electron.exe" .
