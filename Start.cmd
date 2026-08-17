@echo off
rem Double-click this to run the Personal Finance Tool.
rem
rem Installs dependencies on first run, starts the app, and opens it in your browser.
rem No API key is needed to look around.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed, or is not on your PATH.
  echo.
  echo   Install it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

node scripts\start.mjs %*

rem Only pause on failure. A clean Ctrl+C should just close.
if errorlevel 1 (
  echo.
  echo The message above says what went wrong.
  pause
)
