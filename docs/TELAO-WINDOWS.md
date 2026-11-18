# Computador do telão (Windows)

Este guia configura o computador conectado ao telão para:

- abrir o player automaticamente ao ligar;
- exibir em tela cheia (modo quiosque);
- reabrir o player sozinho se o navegador fechar;
- não depender de clique manual.

Ele usa o Chrome ou o Edge, que já vêm no Windows ou são fáceis de instalar. **Não é preciso instalar Node.js, banco de dados, Docker nem nenhum servidor neste computador**: o sistema roda na Cloudflare e o telão só abre uma página HTTPS.

## 1. Pré-requisitos

- Windows 10/11 com **Google Chrome** ou **Microsoft Edge** atualizado.
- Um usuário do Windows que fica **logado** no computador do telão. O ideal é um usuário local dedicado com logon automático (veja o passo 5).
- Acesso à internet e ao endereço do sistema na Cloudflare (teste no navegador: `https://gazin-display.SEU-SUBDOMINIO.workers.dev/api/health` deve retornar `"status":"ok"`). Neste guia, `SEU-SERVIDOR` é esse endereço.
- O endereço da Cloudflare já é **HTTPS**, o que permite o cache offline do player (service worker). Se a rede usar proxy/firewall, libere HTTPS (443) e WebSocket para `*.workers.dev` (ou o domínio próprio).
- Configure o Windows para **não suspender, não desligar a tela e não bloquear**: Configurações → Sistema → Energia → "Nunca". Desative também a proteção de tela.

## 2. Abrir o player pela primeira vez e vincular

1. No computador do telão, abra o Chrome/Edge em `https://SEU-SERVIDOR/player`.
2. A tela mostra **"Vincular este telão"** e um código como `K7M-4QX`. O código vale por 15 minutos e se renova sozinho.
3. No seu computador, entre no painel → **Telões → Vincular telão**, digite o código e o nome do telão.
4. Em poucos segundos o telão mostra a programação publicada (ou a tela de espera, se ainda não houver nenhuma).

> Se você usar o script do passo 3, faça a vinculação **depois** de rodá-lo. O script usa um perfil de navegador próprio, e a credencial do telão fica guardada nesse perfil.

## 3. Inicialização automática em modo quiosque (recomendado: script)

O script [`scripts/windows/instalar-player.ps1`](../scripts/windows/instalar-player.ps1):

- encontra o Chrome ou o Edge pelo registro do Windows, sem caminho fixo;
- cria um perfil de navegador dedicado em `%LOCALAPPDATA%\GazinDisplay\perfil`;
- cria a tarefa agendada **"GAZIN DISPLAY Player"**, que roda no logon do usuário;
- inicia um vigia que abre o player em quiosque e o **reabre em até 20 s** se o navegador for fechado ou travar.

Copie o arquivo para o computador do telão e, **logado com o usuário do telão** (não precisa ser administrador), execute no PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\instalar-player.ps1 -Url https://SEU-SERVIDOR/player
# opcional: -Navegador edge   ou   -Navegador chrome
```

O player abre em tela cheia. Se for o primeiro uso desse perfil, aparece o código de vinculação (passo 2).

O navegador é aberto com estas opções:

| Opção | Motivo |
|---|---|
| `--kiosk` | Tela cheia sem barras nem menus |
| `--autoplay-policy=no-user-gesture-required` | Permite vídeo com áudio sem clique (quando o áudio estiver ligado na playlist) |
| `--user-data-dir=...\GazinDisplay\perfil` | Perfil dedicado: credencial do telão e cache offline persistentes |
| `--disable-session-crashed-bubble --hide-crash-restore-bubble --noerrdialogs` | Sem pop-ups de "restaurar páginas" após quedas de energia |
| `--disable-features=Translate` | Sem barra de tradução |

**Remover:** `powershell -ExecutionPolicy Bypass -File .\instalar-player.ps1 -Remover`
O perfil é mantido, então a credencial continua válida. Apague `%LOCALAPPDATA%\GazinDisplay` para zerar.

**Sair do quiosque para manutenção:** como o vigia reabre o navegador, primeiro pare a tarefa em
Agendador de Tarefas → "GAZIN DISPLAY Player" → **Finalizar**, depois feche o navegador com `Alt+F4`.

### Alternativa manual (sem script)

Crie um atalho na pasta de inicialização (`Win+R` → `shell:startup`) com o destino abaixo. Ajuste o caminho do navegador conforme a instalação do seu computador (no Chrome, veja em `chrome://version` → "Caminho executável"):

```
"<caminho do chrome.exe ou msedge.exe>" --kiosk https://SEU-SERVIDOR/player/ --user-data-dir="%LOCALAPPDATA%\GazinDisplay\perfil" --autoplay-policy=no-user-gesture-required --no-first-run --disable-session-crashed-bubble --noerrdialogs
```

Esse atalho **não** reabre o navegador se ele for fechado. Para isso, use o script.

## 4. Tela cheia e áudio: limitações reais do navegador

- Uma página não pode pedir tela cheia sozinha, sem um clique. Quem garante a tela cheia é o **modo quiosque** (`--kiosk`).
- Por padrão os vídeos tocam **sem áudio**, o que o navegador sempre permite. Se a playlist tiver áudio ligado e o navegador bloquear, o player continua **sem som** e mostra a dica "Clique na tela para ativar o áudio". Um clique do operador libera o som. Com a opção `--autoplay-policy=no-user-gesture-required` do script, isso não acontece.

## 5. Recuperação após reinicializações

- **Logon automático** (para o telão voltar sozinho após queda de energia): use o recurso oficial *Autologon* da Microsoft (Sysinternals) ou a política da sua TI. Não grave senhas em scripts.
- Configure a BIOS/UEFI para **ligar após queda de energia** ("Restore on AC Power Loss → Power On"), se disponível.
- Ao abrir, o player:
  1. carrega a **última programação salva** no próprio computador e começa a reproduzir **mesmo sem servidor**, a partir do cache;
  2. conecta ao servidor e baixa as atualizações pendentes;
  3. continua do mesmo item em que estava antes de recarregar.
- O player se recarrega uma vez por dia, de madrugada, entre duas mídias, para liberar memória.

## 6. Verificar problemas de conexão

| Sintoma | Verificação |
|---|---|
| Painel mostra **Offline** | No telão, abra `https://SEU-SERVIDOR/api/health`. Verifique a rede/proxy/firewall (porta 443 e WebSocket liberados). |
| Painel mostra **Reconectando** | Conexão instável. O telão continua tocando o que já está no cache. |
| Telão mostra o **código de vinculação** | A credencial foi revogada/expirada ou o perfil do navegador foi apagado: vincule novamente. |
| "Atualização pendente" no painel | O telão ainda está baixando os arquivos (veja o progresso em Controle remoto) ou faltou espaço em disco. O erro aparece no painel e no Histórico. |
| Cache local "indisponível (requer HTTPS)" | Abra o player pelo endereço `https://` da Cloudflare (CLOUDFLARE_DEPLOY.md). |
| Vídeo não toca | Use MP4 (H.264) ou WebM. A versão em nuvem não converte formatos (MOV, MKV, HEVC são recusados no envio). Veja Histórico → Erros de reprodução. |
| Precisa ver a tela do player com controles do navegador | Pare a tarefa agendada e abra `https://SEU-SERVIDOR/player` em uma janela normal. |

O botão **Controle remoto → Recarregar player** recarrega a página do telão sem acesso remoto ao computador.
