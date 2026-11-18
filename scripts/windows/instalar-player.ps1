<#
.SYNOPSIS
  Configura o computador do telão para abrir o player do GAZIN DISPLAY automaticamente,
  em modo quiosque (tela cheia), e reabri-lo se o navegador for fechado.

.DESCRIPTION
  - Localiza o Chrome ou o Edge pelo registro do Windows (não usa caminhos fixos).
  - Cria um perfil de navegador dedicado em %LOCALAPPDATA%\GazinDisplay\perfil
    (mantém a credencial do telão e o cache offline separados do uso pessoal).
  - Cria a tarefa agendada "GAZIN DISPLAY Player" que roda no logon do usuário atual
    e executa um vigia (watchdog) que reabre o player caso o navegador seja fechado.

  Execute no computador do telão, logado com o usuário que ficará conectado ao telão:
    powershell -ExecutionPolicy Bypass -File .\instalar-player.ps1 -Url https://display.gazin.com.br/player

  Para remover:  powershell -ExecutionPolicy Bypass -File .\instalar-player.ps1 -Remover
#>
param(
  [string]$Url,
  [ValidateSet('auto', 'chrome', 'edge')][string]$Navegador = 'auto',
  [switch]$Remover
)

$ErrorActionPreference = 'Stop'
$TaskName = 'GAZIN DISPLAY Player'
$Base = Join-Path $env:LOCALAPPDATA 'GazinDisplay'
$Profile = Join-Path $Base 'perfil'
$Watchdog = Join-Path $Base 'vigia-player.ps1'

if ($Remover) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item $Watchdog -Force -ErrorAction SilentlyContinue
  Write-Host "Tarefa removida. O perfil do navegador em $Profile foi mantido (contém a credencial do telão)."
  exit 0
}

if (-not $Url) { $Url = Read-Host 'URL do player (ex.: https://display.gazin.com.br/player)' }
if ($Url -notmatch '^https?://') { throw 'Informe a URL completa, começando com https://' }
if ($Url -notmatch '/player/?$') { $Url = $Url.TrimEnd('/') + '/player/' }
if ($Url -match '^http://' -and $Url -notmatch '^http://(localhost|127\.0\.0\.1)') {
  Write-Warning 'Sem HTTPS o navegador NÃO permite o cache offline do player (service worker). Recomenda-se HTTPS.'
}

function Find-Browser([string]$exe) {
  foreach ($root in 'HKLM:', 'HKCU:') {
    $key = "$root\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe"
    if (Test-Path $key) {
      $p = (Get-ItemProperty $key).'(default)'
      if ($p -and (Test-Path $p)) { return $p }
    }
  }
  return $null
}

$browser = $null
if ($Navegador -in 'auto', 'chrome') { $browser = Find-Browser 'chrome.exe' }
if (-not $browser -and $Navegador -in 'auto', 'edge') { $browser = Find-Browser 'msedge.exe' }
if (-not $browser) { throw 'Chrome ou Edge não encontrado. Instale um dos dois e execute novamente.' }
Write-Host "Navegador: $browser"

New-Item -ItemType Directory -Force -Path $Profile | Out-Null

# Vigia: abre o player em quiosque e reabre se o navegador for fechado.
$watchdogContent = @"
`$ErrorActionPreference = 'SilentlyContinue'
`$browser = '$($browser -replace "'", "''")'
`$profile = '$($Profile -replace "'", "''")'
`$url = '$($Url -replace "'", "''")'
`$args = @(
  '--kiosk', `$url,
  "--user-data-dir=`$profile",
  '--autoplay-policy=no-user-gesture-required',
  '--no-first-run', '--no-default-browser-check',
  '--noerrdialogs', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble',
  '--disable-features=Translate,TranslateUI',
  '--disable-pinch', '--overscroll-history-navigation=0'
)
# aguarda a rede/sessão estabilizarem após o logon
Start-Sleep -Seconds 15
while (`$true) {
  `$running = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { `$_.CommandLine -like "*`$profile*" }
  if (-not `$running) { Start-Process -FilePath `$browser -ArgumentList `$args }
  Start-Sleep -Seconds 20
}
"@
Set-Content -Path $Watchdog -Value $watchdogContent -Encoding UTF8

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Watchdog`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host ''
Write-Host 'Pronto!' -ForegroundColor Green
Write-Host "  Tarefa agendada: '$TaskName' (inicia no logon de $env:USERNAME)"
Write-Host "  Perfil dedicado: $Profile"
Write-Host "  Player:          $Url"
Write-Host ''
Write-Host 'Iniciando agora... (para sair do modo quiosque: Alt+F4)'
Start-ScheduledTask -TaskName $TaskName
