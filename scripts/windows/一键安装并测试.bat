@echo off
chcp 65001 >nul
echo MailHarbor 一键安装并自检
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-and-test.ps1" -StartApp
pause
