@echo off
setlocal
cd /d "%~dp0"
py -3 server.py
if errorlevel 1 goto failed
exit /b 0
:failed
echo PhotoBooth could not start. Check the error above.
pause
exit /b 1
