@echo off
REM CLAIR PRO launcher (Windows). Thin wrapper over launcher.js.
set "DIR=%~dp0"
node "%DIR%launcher.js" %*
