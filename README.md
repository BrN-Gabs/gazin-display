# GAZIN DISPLAY — Gerenciamento de Mídias da Matriz

Sistema web para gerenciar remotamente os vídeos e imagens exibidos nos telões da Gazin.
O administrador envia mídias, monta playlists e publica pelo navegador. O computador do
telão recebe as atualizações sozinho, sem acesso remoto.

```
 Navegador do administrador ──HTTPS──▶  Cloudflare (Worker + D1 + R2)  ◀──HTTPS/WebSocket── Computador do telão
   /admin (painel)                     API, tempo real (Durable Object),                  /player (modo quiosque)
                                       banco D1, mídias no R2                              só o navegador + cache offline
```

Nenhum servidor próprio: a Cloudflare hospeda o site, executa a API, mantém o banco e armazena as mídias.
O computador do telão não precisa de Node.js, banco de dados nem Docker.

| Documento | Conteúdo |
|---|---|
| [CLOUDFLARE_DEPLOY.md](CLOUDFLARE_DEPLOY.md) | **Implantação na Cloudflare**: recursos, configuração, publicação, telão, atualizações, custos |
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Análise do exibidor original, decisões técnicas, modelo de dados, sincronização, testes |
| [docs/TELAO-WINDOWS.md](docs/TELAO-WINDOWS.md) | Configuração do computador do telão (quiosque, inicialização automática, problemas) |

## Tecnologias

- **Backend:** Cloudflare Workers (TypeScript, Hono, Zod), Durable Object `RealtimeHub` (WebSocket Hibernation), Cron Trigger
- **Banco de dados:** Cloudflare D1 (SQLite), migrations em `migrations/`
- **Mídias:** Cloudflare R2 Standard, upload multipart direto do navegador com URLs temporárias assinadas
- **Painel:** React 19, Vite, Tailwind CSS 4, TanStack Query, dnd-kit, Lucide, Sonner (componentes próprios no estilo shadcn/ui)
- **Player:** TypeScript sem framework, Service Worker e Cache Storage (offline)
- **Análise de mídia:** no navegador de quem envia (metadados, miniatura, SHA-256)
- **Segurança:** PBKDF2 (Web Crypto), cookies HttpOnly/Secure/SameSite, CSRF por cabeçalho e origem, limite de tentativas no D1, credenciais próprias por dispositivo
- **Testes:** Vitest (unitários e integração contra o Worker real em `wrangler dev`) e Playwright (end-to-end no Chrome)

## Estrutura do projeto

```
wrangler.jsonc             configuração do Worker (assets, D1, R2, Durable Object, cron, variáveis)
migrations/                migrations do D1
r2-cors.json               CORS do bucket (upload direto)
src/
  worker/                  backend (Cloudflare Workers)
    index.ts               entrada: middlewares (CSRF, cabeçalhos, erros), WebSocket, cron
    auth.ts                sessões, credenciais de dispositivo, guards, limite de tentativas
    db.ts                  acesso ao D1
    realtime/              RealtimeHub (Durable Object) e cliente usado pelas rotas
    routes/                auth, users, media (+upload multipart), playlists, devices, player, schedules, system
    services/              publicação, telões/agendamento, auditoria, configurações
    lib/                   segurança, R2 (URLs assinadas), HTTP (Range)
  shared/                  tipos e regras compartilhadas (protocolo do player, agendamento)
  web/                     painel administrativo (React)
    lib/socket.ts          cliente WebSocket (painel e player)
    lib/media-probe.ts     análise das mídias no navegador
  player/                  player do telão (motor de reprodução, cache, service worker)
public/_headers, _redirects  cabeçalhos de segurança e redirecionamentos dos assets
scripts/                   create-admin, migrate-legacy (versão 1 → Cloudflare), dev
tests/                     unit/  integration/  e2e/
scripts/windows/instalar-player.ps1   configuração do computador do telão
```

## Comandos

| Comando | Função |
|---|---|
| `npm run dev` | Worker local (`wrangler dev`, D1/R2/DO simulados) + painel Vite em http://localhost:5173/admin |
| `npm run build` | Gera o painel e o player (`dist/web`) |
| `npm run deploy` | Build + publicação na Cloudflare |
| `npm run db:migrate:local` / `db:migrate:remote` | Aplica as migrations do D1 (local / produção) |
| `npm run create-admin -- --local` / `--remote` | Cria um administrador ou redefine a senha dele |
| `npm run migrate:legacy` | Migra banco e arquivos da versão 1 (veja CLOUDFLARE_DEPLOY.md, B9) |
| `npm run typecheck` | Verificação de tipos (Worker, frontend e scripts) |
| `npm test` | Testes unitários e de integração (sobe um Worker local isolado) |
| `npm run test:e2e` | Testes end-to-end no Chrome instalado (`E2E_CHANNEL=msedge` para Edge) |

> **Windows:** rode os testes pelo PowerShell ou CMD. No Git Bash, a diferença `c:` × `C:` no caminho pode fazer o Vitest falhar.

A versão 1 (servidor Node.js/Fastify + PostgreSQL) está preservada na tag `v1-node-fastify`.

## Primeiro administrador

```powershell
npm run create-admin -- --remote --email voce@gazin.com.br --name "Seu Nome"
```

- A senha é pedida no terminal, oculta; só o hash é gravado no D1.
- Precisa ter 10 ou mais caracteres e 3 tipos (maiúsculas, minúsculas, números, símbolos).
- Esqueceu a senha? Rode o mesmo comando: ele redefine a senha e encerra as sessões do usuário.

Os demais usuários (Administrador/Editor) são criados no painel em **Configurações → Usuários**.

## Cadastrar o computador do telão

1. No computador do telão, abra `https://SEU-ENDERECO/player`. Um código aparece na tela (ex.: `K7M-4QX`).
2. No painel, vá em **Telões → Vincular telão**, digite o código e dê um nome (ex.: "Telão da Matriz").
3. O telão recebe uma **credencial própria** (cookie HttpOnly, válida por 365 dias e renovada com o uso). A senha administrativa nunca é digitada no telão.
4. Configure a abertura automática em modo quiosque: [docs/TELAO-WINDOWS.md](docs/TELAO-WINDOWS.md).

Para trocar o computador, use **Vincular telão → Telão já cadastrado**: o computador anterior perde o acesso.
Para bloquear um telão, use **Revogar acesso**.

## Publicar a primeira playlist

1. **Biblioteca de Mídias → Adicionar vídeos / imagens** (ou arraste os arquivos). Acompanhe o progresso no canto inferior direito.
2. **Playlists → Nova playlist → Adicionar mídias**. Arraste para ordenar e ajuste o tempo das imagens (padrão: 30 s).
3. **Salvar** grava o rascunho. O telão **não** muda ainda.
4. **Publicar no telão** cria a versão 1. Escolha o telão e quando aplicar (próximo intervalo ou imediatamente).
5. A janela de publicação mostra quando o telão baixou os arquivos e começou a reproduzir a nova versão.

## Recursos

- **Login e permissões:** Administrador e Editor (com ou sem permissão de publicar/controlar), aplicadas no servidor.
- **Biblioteca:**
  - Upload em partes direto ao R2, retomável, com progresso por arquivo e cancelamento.
  - O formato real é validado pela assinatura binária; uploads duplicados são evitados (SHA-256).
  - Miniaturas, duração e resolução são extraídas automaticamente (no navegador).
  - Formatos que exigem conversão (MOV, MKV, HEVC…) são recusados com orientação para enviar MP4 (H.264).
  - Limite lógico de armazenamento configurável, com aviso ao se aproximar.
  - Grade e lista, busca, filtros, ordenação, renomear e descrição.
  - Exclusão protegida quando a mídia está na programação publicada.
- **Playlists:**
  - Arrastar e soltar, duração global ou por item, loop, áudio, contain/cover, imagem de fallback.
  - Rascunho separado do publicado, versões imutáveis com histórico e prévia, duplicação.
  - Controle de edição concorrente.
- **Telões:** vinculação por código temporário, credencial por dispositivo, renovação e revogação, status Online/Reconectando/Offline, estado em tempo real.
- **Controle remoto:**
  - Pausar, continuar, próxima, anterior, reiniciar, ir para item, recarregar, sincronizar, áudio e ajuste de tela.
  - O painel só confirma o comando quando o telão responde. Com o telão offline, não há confirmação falsa.
- **Player:**
  - Tela cheia limpa, com pré-carregamento da próxima mídia em camada dupla (sem tela preta).
  - Loop infinito, watchdog de vídeo travado, pula mídias com erro e mostra o fallback se tudo falhar.
  - Retoma do mesmo item após recarregar e aplica nova versão no intervalo entre mídias.
  - Reprodução offline a partir do cache, com verificação de integridade (SHA-256).
- **Sincronização:**
  - Eventos WebSocket (Durable Object com hibernação).
  - Reconciliação periódica por HTTP (a cada 60 s e a cada reconexão), sem depender só de eventos.
  - Número de versão sequencial por publicação.
- **Programação:**
  - Agendamentos por dias da semana, horário, período e prioridade, no fuso America/Sao_Paulo.
  - Janelas que atravessam a meia-noite são suportadas, e conflitos são bloqueados ou exibidos.
  - A Cloudflare aplica os agendamentos sozinha (cron a cada minuto), com o painel fechado.
- **Histórico:** auditoria persistente (usuário, telão, ação, detalhes) com filtros, sem senhas ou tokens.
- **Configurações:** padrões de reprodução, comportamento sem conteúdo, limite de upload e de armazenamento, limiar de offline, usuários, troca de senha e sessões.

## Testes

Os testes executados nesta entrega estão descritos em [docs/ARQUITETURA.md#testes](docs/ARQUITETURA.md#testes),
com a relação de cada cenário obrigatório ao teste que o cobre.
