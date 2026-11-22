@echo off
rem ============================================================================
rem My own WEB instance for testing dsh-plugin-myteam.
rem
rem Hard rule: NEVER launch the desktop binary here
rem ("DeepSeek Harness.exe ... dsh-desktop-host\lib\cli.js"). That shares the
rem desktop's process identity/state and has crashed the user's running
rem desktop app. Use the runtime CLI's web app instead: `dsh --profile <name>`.
rem
rem The profile is a throwaway test profile whose package.json links this repo:
rem   dsh plugin --profile myteam-web add link:E:/Workplace/extension/dsh-myteam/plugin
rem (do it with the CLI, never by editing profile files by hand).
rem
rem Usage:
rem   tools\boot-test-web.cmd            serve on 3099
rem   tools\boot-test-web.cmd 3104       serve on another port
rem   tools\boot-test-web.cmd 3104 log   also disable the password gate for a
rem                                      passwordless test instance (patch file
rem                                      overlay only, nothing on disk changes)
rem
rem Stop it by closing this window, or kill the process listening on the port.
rem ============================================================================
setlocal
set "PORT=%~1"
if "%PORT%"=="" set "PORT=3099"
set "MODE=%~2"
set "PATCH="
if /i "%MODE%"=="log" set "PATCH=--patch .debug\test-web\patch-noprobe.yml"

set "DSH=C:\APP\agent\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
if not exist "%DSH%" (
  echo dsh CLI not found: %DSH%
  exit /b 1
)

cd /d "%~dp0.."
echo [boot-test-web] profile=myteam-web port=%PORT% patch=%PATCH%
"%DSH%" --profile myteam-web --host 127.0.0.1 --port %PORT% --no-open %PATCH%
