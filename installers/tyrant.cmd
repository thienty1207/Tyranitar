@echo off
setlocal
set "TYRANT_HOME=%LOCALAPPDATA%\Tyrant"
set "TYRANT_ROOT="
for /f "usebackq delims=" %%T in ("%TYRANT_HOME%\current.txt") do set "TYRANT_ROOT=%%T"
if not defined TYRANT_ROOT (
  echo Tyrant is not installed for this user. 1>&2
  exit /b 2
)
if not exist "%TYRANT_ROOT%\src\cli.ts" (
  echo Tyrant active installation is incomplete. 1>&2
  exit /b 2
)
set "TYRANT_INSTALL_ROOT=%TYRANT_HOME%"
if not defined TYRANT_BUN_PATH if exist "%USERPROFILE%\.bun\bin\bun.exe" set "TYRANT_BUN_PATH=%USERPROFILE%\.bun\bin\bun.exe"
for /f "delims=" %%B in ('where.exe bun 2^>nul') do if not defined TYRANT_BUN_PATH set "TYRANT_BUN_PATH=%%B"
if not exist "%TYRANT_BUN_PATH%" (
  echo Bun runtime is missing. Reinstall Tyrant or restore Bun at %%USERPROFILE%%\.bun\bin\bun.exe. 1>&2
  exit /b 2
)
call "%TYRANT_BUN_PATH%" run "%TYRANT_ROOT%\src\cli.ts" %*
exit /b %ERRORLEVEL%
