@echo off
chcp 65001 >nul
setlocal
title GAZIN DISPLAY - Instalar servidor
cd /d "%~dp0"

rem ---- pede permissao de Administrador (necessario para iniciar junto com o Windows) ----
net session >nul 2>&1
if errorlevel 1 (
  echo Solicitando permissao de Administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo ==============================================
echo   GAZIN DISPLAY - Instalacao do servidor
echo ==============================================
echo Pasta: %CD%
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Instale o Node.js 22 ou superior em https://nodejs.org e execute novamente.
  goto fim
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Arquivo .env criado. O Bloco de Notas vai abrir:
  echo   - ajuste ADMIN_EMAIL e ADMIN_PASSWORD
  echo   - troque a senha do banco em DATABASE_URL ^(gazin-dev^)
  echo   - em PUBLIC_URL coloque http://IP-DESTA-MAQUINA:3000
  echo Salve, feche o Bloco de Notas e volte aqui.
  start /wait notepad ".env"
)

if not exist "node_modules" (
  echo.
  echo Instalando dependencias ^(npm install^)... isso pode levar alguns minutos.
  call npm install
  if errorlevel 1 ( echo [ERRO] Falha no npm install. & goto fim )
)

if not exist "dist\server\server\index.js" (
  echo.
  echo Compilando o sistema ^(npm run build^)...
  call npm run build
  if errorlevel 1 ( echo [ERRO] Falha no build. & goto fim )
)

echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\instalar-servidor.ps1"
if errorlevel 1 ( echo [ERRO] A instalacao nao foi concluida. Veja a mensagem acima. & goto fim )

echo.
echo Liberando a porta do painel no firewall do Windows...
for /f "tokens=2 delims==" %%p in ('findstr /b /c:"PORT=" ".env"') do set APP_PORT=%%p
if "%APP_PORT%"=="" set APP_PORT=3000
powershell -NoProfile -Command "if (-not (Get-NetFirewallRule -DisplayName 'GAZIN DISPLAY' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'GAZIN DISPLAY' -Direction Inbound -Protocol TCP -LocalPort %APP_PORT% -Action Allow -Profile Domain,Private | Out-Null; 'Porta %APP_PORT% liberada.' } else { 'Regra de firewall ja existe.' }"

echo.
echo Pronto! Em alguns segundos o painel estara em http://localhost:%APP_PORT%/admin
echo Log do servidor: %CD%\logs\servidor.log

:fim
echo.
pause
