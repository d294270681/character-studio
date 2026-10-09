@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0runtime\node\node.exe" (
  echo Local Node runtime missing. Run Setup.cmd -Mode Install first.
  exit /b 2
)
if not exist "%~dp0electron\ui\index.html" (
  echo UI build missing. Run Setup.cmd -Mode Install first.
  exit /b 2
)
"%~dp0runtime\node\node.exe" "%~dp0electron\node_modules\electron\cli.js" "%~dp0electron"
exit /b %ERRORLEVEL%
