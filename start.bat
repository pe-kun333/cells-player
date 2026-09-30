@echo off
rem Cells Player launcher (double-click to start).
rem Keep this file ASCII only: Japanese text in a .bat file makes cmd.exe misread lines,
rem so Japanese messages are printed by serve.py or PowerShell instead.
cd /d "%~dp0"
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if defined PY (
  %PY% serve.py
) else (
  echo Python was not found. Install it from https://www.python.org/ and run start.bat again.
  powershell -NoProfile -Command "Write-Host ([regex]::Unescape('Python \u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3002https://www.python.org/ \u304b\u3089\u30a4\u30f3\u30b9\u30c8\u30fc\u30eb\u3057\u3066\u3001\u3082\u3046\u4e00\u5ea6 start.bat \u3092\u8d77\u52d5\u3057\u3066\u304f\u3060\u3055\u3044\u3002'))"
)
pause
