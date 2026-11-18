@echo off
chcp 65001 >nul
setlocal
title GAZIN DISPLAY - Instalar player do telao
cd /d "%~dp0"

rem Funciona na pasta do projeto ou copiado sozinho junto com instalar-player.ps1
set "SCRIPT=%~dp0scripts\windows\instalar-player.ps1"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0instalar-player.ps1"
if not exist "%SCRIPT%" (
  echo [ERRO] instalar-player.ps1 nao encontrado. Copie-o para a mesma pasta deste arquivo.
  goto fim
)

echo.
echo ==============================================
echo   GAZIN DISPLAY - Configurar o telao
echo ==============================================
echo Execute logado com o usuario que ficara no telao ^(sem "Executar como administrador"^).
echo.
echo Endereco do player na Cloudflare (HTTPS), por exemplo:
echo   https://gazin-display.SEU-SUBDOMINIO.workers.dev/player
echo Nao e preciso instalar Node.js nem servidor neste computador: so o navegador.
echo.
set "URL="
set /p "URL=Endereco: "
if "%URL%"=="" ( echo [ERRO] Informe o endereco do player. & goto fim )

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Url "%URL%"
if errorlevel 1 ( echo [ERRO] A configuracao nao foi concluida. Veja a mensagem acima. & goto fim )

echo.
echo Pronto! O player abrira em tela cheia. Se aparecer um codigo, vincule-o no painel em Teloes - Vincular telao.

:fim
echo.
pause
