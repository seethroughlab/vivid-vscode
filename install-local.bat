@echo off
setlocal

REM Install Vivid VS Code extension locally

cd /d "%~dp0"

echo Installing dependencies...
call npm install
if errorlevel 1 goto :error

echo Packaging extension...
call npm run package
if errorlevel 1 goto :error

for /f "delims=" %%i in ('dir /b /o-d *.vsix 2^>nul') do (
    set "VSIX_FILE=%%i"
    goto :found
)

echo Error: No .vsix file found
exit /b 1

:found
echo Installing %VSIX_FILE%...
call code --install-extension "%VSIX_FILE%"
if errorlevel 1 goto :error

echo Done! Restart VS Code to use the extension.
exit /b 0

:error
echo Installation failed.
exit /b 1
