@echo off
setlocal
powershell.exe -ExecutionPolicy Bypass -File "%~dp0run-codex-feedback.ps1" %*
exit /b %ERRORLEVEL%
