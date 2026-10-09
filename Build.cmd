@echo off
setlocal
cd /d "%~dp0electron"
if not exist "%~dp0runtime\node\node.exe" (
  echo Run Setup.cmd -Mode Install first.
  exit /b 2
)
set "PATH=%~dp0runtime\node;%PATH%"
"%~dp0runtime\node\node.exe" "%~dp0runtime\node\node_modules\npm\bin\npm-cli.js" run package
exit /b %ERRORLEVEL%
