@echo off
REM One-click rebuild Chrome extension (double-click or run from Explorer)
cd /d "%~dp0.."
node scripts\rebuild-extension.mjs %*
if errorlevel 1 (
  echo.
  echo Build failed.
  pause
  exit /b 1
)
echo.
pause
