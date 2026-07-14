@echo off
setlocal
call "%~dp0scripts\start-desktop.cmd"
if errorlevel 1 (
  echo.
  echo Codex Browser failed to start.
  pause
  exit /b 1
)
