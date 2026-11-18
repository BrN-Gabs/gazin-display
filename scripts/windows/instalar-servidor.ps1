<#
.SYNOPSIS
  Faz o servidor GAZIN DISPLAY iniciar com o Windows e reiniciar sozinho se cair (somente Node, sem Docker).

.DESCRIPTION
  - Usa a pasta do projeto onde este script está (não há caminhos fixos) e o node.exe do PATH.
  - Cria a tarefa agendada "GAZIN DISPLAY Servidor":
      * executando como Administrador: inicia junto com o Windows (antes de qualquer logon);
      * sem privilégio: inicia no logon do usuário atual.
  - Um vigia reinicia o servidor 5 s após qualquer encerramento inesperado.
  - Logs em <projeto>\logs\servidor.log

  Pré-requisitos (uma vez, na pasta do projeto):  npm install ; copiar .env.example para .env e ajustar ; npm run build

  Uso:     powershell -ExecutionPolicy Bypass -File scripts\windows\instalar-servidor.ps1
  Remover: powershell -ExecutionPolicy Bypass -File scripts\windows\instalar-servidor.ps1 -Remover
#>
param([switch]$Remover)

$ErrorActionPreference = 'Stop'
$TaskName = 'GAZIN DISPLAY Servidor'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Runner = Join-Path $Root 'logs\executar-servidor.ps1'

if ($Remover) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host 'Tarefa removida. Os dados (banco e mídias) foram mantidos.'
  exit 0
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js não encontrado no PATH. Instale o Node.js 22 ou superior.' }
if (-not (Test-Path (Join-Path $Root '.env'))) { throw "Arquivo .env não encontrado em $Root. Copie .env.example para .env e ajuste." }
if (-not (Test-Path (Join-Path $Root 'dist\server\server\index.js'))) { throw "Build não encontrado. Rode 'npm run build' em $Root." }

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs') | Out-Null
$runnerContent = @"
`$ErrorActionPreference = 'Continue'
Set-Location '$($Root -replace "'", "''")'
`$log = Join-Path '$($Root -replace "'", "''")' 'logs\servidor.log'
while (`$true) {
  # rotação simples: mantém o log abaixo de ~50 MB
  if ((Test-Path `$log) -and (Get-Item `$log).Length -gt 50MB) { Move-Item `$log "`$log.1" -Force }
  Add-Content `$log "==== iniciando servidor `$(Get-Date -Format s) ===="
  & '$($node -replace "'", "''")' 'dist\server\server\index.js' *>> `$log
  Add-Content `$log "==== servidor encerrado (código `$LASTEXITCODE) `$(Get-Date -Format s); reiniciando em 5 s ===="
  Start-Sleep -Seconds 5
}
"@
Set-Content -Path $Runner -Value $runnerContent -Encoding UTF8

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Runner`"" -WorkingDirectory $Root
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
if ($isAdmin) {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message 'Senha do usuário do Windows que executará o servidor (necessária para iniciar sem logon)'
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null
  Write-Host "Tarefa '$TaskName' criada: inicia junto com o Windows."
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "Tarefa '$TaskName' criada: inicia no logon de $env:USERNAME. (Execute como Administrador para iniciar junto com o Windows, sem logon.)"
}
Start-ScheduledTask -TaskName $TaskName
Write-Host "Servidor iniciando. Log: $Root\logs\servidor.log"
Write-Host 'Teste em alguns segundos: http://localhost:<PORT>/api/health'
