@echo off
title Sound Direction Estimation Dashboard - NMAMIT SRIP
echo ====================================================================
echo  Sound Direction Estimation using Machine Learning and TinyML
echo  Student: Hithesh H G (CSE) - NMAMIT / NITTE
echo ====================================================================
echo.
echo Launching React Dashboard at http://127.0.0.1:5173 ...
cd /d "%~dp0dashboard"
start http://127.0.0.1:5173
call npm run dev -- --host 127.0.0.1 --port 5173
pause
