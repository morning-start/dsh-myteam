@echo off
rem ============================================================================
rem Isolated test instance for dsh-plugin-myteam.
rem
rem Why: the desktop app (and any other running DSH) owns ~/.dsh: sessions,
rem storages, credentials, writer leases. A second instance that shares that home
rem fights over sessions and can knock the running host over. This script gives
rem the test instance its OWN home, so nothing is shared at all:
rem
rem   DSH_HOME = <repo>\tmp\iso-home     (sessions, storages, credentials, $DSH_HOME/myteam)
rem   profile  = iso-myteam              (fresh copy of the shipped web template + this plugin)
rem   port     = 3099                    (never the port a real instance listens on)
rem
rem The plugin is added with the CLI (`dsh plugin ... add link:`), never by hand.
rem Do NOT launch "DeepSeek Harness.exe ... dsh-desktop-host\cli.js" from here:
rem that is the desktop binary and it takes the running desktop down.
rem
rem Usage:
rem   tools\boot-iso-web.cmd            first run creates the profile, then serves on 3099
rem   tools\boot-iso-web.cmd 3104       serve on another port
rem
rem Stop: Ctrl+C in this window (the console stays attached, so it really stops).
rem ============================================================================
setlocal enabledelayedexpansion
set "PORT=%~1"
if "%PORT%"=="" set "PORT=3099"

cd /d "%~dp0.."
set "ROOT=%CD%"
rem ISO can be overridden by an external DSH_HOME: verify-live.mjs uses its own home
rem so it does not fight verify-iso.mjs over the same directory.
if "%DSH_HOME%"=="" set "DSH_HOME=%ROOT%\tmp\iso-home"
set "ISO=%DSH_HOME%"
set "DSH=C:\APP\agent\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

if not exist "%DSH%" (
  echo [iso] dsh CLI not found: %DSH%
  exit /b 1
)
if not exist "%ISO%" mkdir "%ISO%"
set "DSH_HOME=%ISO%"

if "%ISO_PROFILE%"=="" set "ISO_PROFILE=iso-myteam"

rem ---------------------------------------------------------------------------
rem Profile creation is written flat (no :label subroutine, no !VAR! delayed
rem expansion) on purpose:
rem   - cmd.exe refused to resolve "call :create_profile" in this file
rem     ("The system cannot find the batch label specified - create_profile")
rem     even though a minimal file with the same shape worked;
rem   - the original nested-if version used !LINK!, which produced a literal
rem     "!LINK!" the first time the block actually ran. That bug was invisible
rem     for a long time because every earlier run took the "profile already
rem     exists" path and skipped the block entirely.
rem A flat sequence with plain %VAR% has neither failure mode.
rem ---------------------------------------------------------------------------
if exist "%ISO%\profiles\%ISO_PROFILE%\package.json" goto :iso_serve

echo [iso] creating profile "%ISO_PROFILE%" from the shipped web template ...
call "%DSH%" --profile %ISO_PROFILE% --from-default-profile web --dump-config > nul
if errorlevel 1 (
  echo [iso] profile creation failed
  exit /b 1
)

set "LINK=link:%ROOT:\=/%/plugin"
echo [iso] adding plugin: %LINK%
call "%DSH%" plugin --profile %ISO_PROFILE% add "%LINK%"
if errorlevel 1 (
  echo [iso] plugin install failed
  exit /b 1
)

:iso_serve
echo [iso] DSH_HOME=%ISO%
echo [iso] profile=%ISO_PROFILE% port=%PORT%

rem Screenshot / manual-check workspace: a copy of this repo's dogfood project, so the
rem panel has real teams and tasks without touching the repo itself. Pick this folder in
rem the workspace picker; the writer lock of the original is removed in the copy.
if not exist "%ROOT%\tmp\shot-ws\.dsh-myteam\events\project.jsonl" (
  if not exist "%ROOT%\tmp\shot-ws" mkdir "%ROOT%\tmp\shot-ws"
  echo [iso] seeding workspace copy: tmp\shot-ws
  xcopy /e /i /y "%ROOT%\.dsh-myteam" "%ROOT%\tmp\shot-ws\.dsh-myteam" >nul
  del "%ROOT%\tmp\shot-ws\.dsh-myteam\state\writer.lock" >nul 2>&1
)

echo [iso] open the printed ?token= URL in a browser; Ctrl+C stops only this instance.
echo.
rem Optional extra CLI flags, e.g. for a cookie-injecting preview proxy:
rem   set ISO_EXTRA_ARGS=--trusted-host 127.0.0.1:3098
call "%DSH%" --profile %ISO_PROFILE% --host 127.0.0.1 --port %PORT% --no-open %ISO_EXTRA_ARGS%