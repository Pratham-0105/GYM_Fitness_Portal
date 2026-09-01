@echo off
title ARYA FITNESS PORTAL SERVER
echo ======================================================
echo    STARTING ARYA FITNESS CLUB GYM PORTAL SERVER...
echo ======================================================
echo.

cd /d "%~dp0"
start http://localhost:5000
node serve.js
pause
