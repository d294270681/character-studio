@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Setup.ps1" %*
set "studio_exit=%ERRORLEVEL%"
if not "%studio_exit%"=="0" echo Setup did not complete. Read the message above; existing data was preserved.
exit /b %studio_exit%
