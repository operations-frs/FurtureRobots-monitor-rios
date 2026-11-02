@echo off
cd /d "%~dp0"
if exist "%LOCALAPPDATA%\Python\bin\python.exe" (
  "%LOCALAPPDATA%\Python\bin\python.exe" app.py
) else (
  py app.py
)
pause
