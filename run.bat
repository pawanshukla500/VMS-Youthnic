@echo off
setlocal

set "ROOT=%~dp0"
set "LOCAL_NODE=%ROOT%node\node-v20.11.1-win-x64"
set "PATH=%LOCAL_NODE%;%PATH%"
set "NPM_CMD=%LOCAL_NODE%\npm.cmd"
set "APP_URL=http://127.0.0.1:5173/packing"

echo Setting Node.js PATH...

IF NOT EXIST "%NPM_CMD%" (
    set "NPM_CMD=npm.cmd"
)

echo Checking if dependencies are installed...
IF NOT EXIST "%ROOT%client\node_modules" (
    echo Frontend dependencies are still installing. Please wait a few moments and try again!
    pause
    exit /b
)
IF NOT EXIST "%ROOT%server\node_modules" (
    echo Backend dependencies are still installing. Please wait a few moments and try again!
    pause
    exit /b
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
IF ERRORLEVEL 1 (
    echo Starting Backend Server on http://127.0.0.1:8080 ...
    start "VMS Backend" /D "%ROOT%server" cmd /k ""%NPM_CMD%" run dev"
) ELSE (
    echo Backend already running on port 8080.
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
IF ERRORLEVEL 1 (
    echo Starting Frontend Development Server on http://127.0.0.1:5173 ...
    start "VMS Frontend" /D "%ROOT%client" cmd /k ""%NPM_CMD%" run dev -- --host 127.0.0.1"
) ELSE (
    echo Frontend already running on port 5173.
)

echo Opening %APP_URL% ...
ping -n 4 127.0.0.1 >nul
start "" "%APP_URL%"

echo.
echo Local app: %APP_URL%
echo Backend:   http://127.0.0.1:8080
pause
