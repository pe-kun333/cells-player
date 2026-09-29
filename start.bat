@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 serve.py
  goto end
)
where python >nul 2>nul
if %errorlevel%==0 (
  python serve.py
  goto end
)
echo Python が見つかりません。https://www.python.org/ からインストールしてください。
:end
pause
