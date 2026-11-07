@echo off
rem Inicia o servidor local do MultiCorder e abre o navegador (Firefox, se instalado).
rem Usa a porta 8080; se ela ja tiver o MultiCorder, so abre o navegador.
rem Para usar outra porta: iniciar.bat 8090
chcp 65001 >nul
cd /d "%~dp0"
set "PORTA=%~1"
if "%PORTA%"=="" set "PORTA=8080"

where py >nul 2>nul
if not errorlevel 1 (
  py -3 serve.py %PORTA% --open
  goto fim
)
where python >nul 2>nul
if not errorlevel 1 (
  python serve.py %PORTA% --open
  goto fim
)
echo Python nao encontrado. Instale em https://www.python.org/downloads/ e marque "Add to PATH".

:fim
pause
