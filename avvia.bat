@echo off
REM Avvia il simulatore: doppio clic su questo file.
REM Usa npm.cmd, che funziona anche se PowerShell blocca gli script.
cd /d "%~dp0"
if not exist node_modules (
  echo Installazione dipendenze...
  call npm.cmd install
)
start "" http://localhost:5173
call npm.cmd run dev
pause
