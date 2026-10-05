@echo off
setlocal
cd /d "%~dp0"

rem ---- Diagnostics: even if cmd fails before reaching Node, we still get a log ----
set "RC=1"
echo ==== launcher.cmd ==== > "%~dp0startup.log"
echo time: %DATE% %TIME% >> "%~dp0startup.log"
echo cwd: %CD% >> "%~dp0startup.log"
echo script dir: %~dp0 >> "%~dp0startup.log"
echo args: %* >> "%~dp0startup.log"

if not exist "%~dp0launcher.js" (
  echo ERROR: launcher.js not found in %~dp0 >> "%~dp0startup.log"
  echo.
  echo   [ERROR] launcher.js is missing from:
  echo       %~dp0
  echo.
  echo   Please make sure all project files were extracted to the same folder.
  echo.
  goto :end
)

set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\npm\node.exe" set "NODE_EXE=%APPDATA%\npm\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%LOCALAPPDATA%\dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE (
  echo ERROR: Node.js not found >> "%~dp0startup.log"
  echo.
  echo   [ERROR] Node.js not found.
  echo.
  echo   This tool needs Node.js to run. Please install the LTS build from:
  echo       https://nodejs.org/
  echo   Then double-click this file again.
  echo.
  goto :end
)

echo node: %NODE_EXE% >> "%~dp0startup.log"
"%NODE_EXE%" "%~dp0launcher.js" %*
set "RC=%ERRORLEVEL%"
echo node exit code: %RC% >> "%~dp0startup.log"

:end
echo.
echo   ------------------------------------------------------------
echo   Done. If something went wrong, see:
echo       %~dp0startup.log
echo   This window will close when you press a key.
echo   ------------------------------------------------------------
pause >nul
rem pass node's exit code through (pause overwrites ERRORLEVEL, hence RC)
exit /b %RC%
