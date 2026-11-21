@echo off
rem ============================================================================
rem 无密码测试实例（CHG-213 测试约定：**桌面端写、web 实例测**）
rem
rem 为什么这么分工：桌面端进程只在启动时加载 lib/*.mjs —— 改完插件必须重启才生效；
rem 而这个 CLI 实例**每次启动都重新加载**，所以永远跑最新代码，测试端不需要重启桌面端。
rem 登录门（dsh-web-login）在这里被关掉（见 .debug/test-web/patch*.yml），
rem 启动后直接用打印出来的 http://127.0.0.1:3080/?token=... 打开，没有密码页。
rem
rem 用法：
rem   tools\boot-test-web.cmd            只起 web（不跑探针，进程常驻）
rem   tools\boot-test-web.cmd 5 w3       起 web 并跑 stage=5 的活体探针（跑完自动退出）
rem   tools\boot-test-web.cmd 3          同上，stage=3（wake/载体验收）
rem ============================================================================
setlocal
set "STAGE=%~1"
set "TAG=%~2"
if "%TAG%"=="" set "TAG=tweb"
if "%STAGE%"=="" goto webonly
goto probe

:webonly
set "PATCH=E:\Workplace\extension\dsh-myteam\.debug\test-web\patch-noprobe.yml"
goto boot

:probe
set "PATCH=E:\Workplace\extension\dsh-myteam\.debug\test-web\patch.yml"
set "LIVE_STAGE=%STAGE%"
set "LIVE_TAG=%TAG%"

:boot
set "ELECTRON_RUN_AS_NODE=1"
cd /d E:\Workplace\extension\mt-e2e-test
"C:\APP\agent\DeepSeek Harness\DeepSeek Harness.exe" --expose-internals "C:\APP\agent\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" --profile myteam-web --patch "%PATCH%" --no-open
