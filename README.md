# GAZIN DISPLAY — Gerenciamento de Mídias da Matriz

Sistema web para gerenciar remotamente os vídeos e imagens exibidos nos telões da Gazin.
O administrador envia mídias, monta playlists e publica pelo navegador. O computador do
telão recebe as atualizações sozinho, sem acesso remoto.

```
 Navegador do administrador ──HTTPS──▶  Servidor GAZIN DISPLAY  ◀──HTTPS/WebSocket── Computador do telão
   /admin (painel)                     API REST + Socket.IO                          /player (modo quiosque)
                                       PostgreSQL + armazenamento de mídias          cache offline local
```

| Documento | Conteúdo |
|---|---|
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Análise do exibidor original, decisões técnicas, modelo de dados, sincronização |
| [docs/PRODUCAO.md](docs/PRODUCAO.md) | Implantação (servidor interno, VPS, Docker, HTTPS, S3, backup) |
| [docs/TELAO-WINDOWS.md](docs/TELAO-WINDOWS.md) | Configuração do computador do telão (quiosque, inicialização automática, problemas) |

## Tecnologias

- **Backend:** Node.js 22+ com TypeScript, Fastify 5, Socket.IO 4, Zod, Pino (logs estruturados)
- **Banco de dados:** PostgreSQL com Prisma 7 (migrations versionadas em `prisma/migrations`)
- **Painel:** React 19, Vite, Tailwind CSS 4, TanStack Query, dnd-kit, Lucide, Sonner (componentes próprios no estilo shadcn/ui)
- **Player:** TypeScript sem framework, Service Worker e Cache Storage (offline)
- **Mídia:** FFmpeg/FFprobe (validação, duração, miniaturas, conversão) e Sharp (imagens)
- **Segurança:** Argon2id, cookies HttpOnly, CSRF por cabeçalho e origem, rate limiting, credenciais próprias por dispositivo
- **Testes:** Vitest (unitários e integração com PostgreSQL real) e Playwright (end-to-end no Chrome)
- **Infra:** execução somente com Node.js (PostgreSQL embutido), health checks; Docker/Compose opcionais

## Estrutura do projeto

```
prisma/
  schema.prisma            modelo de dados
  migrations/              migrations versionadas
src/
  server/                  backend
    app.ts                 montagem do Fastify (segurança, rotas, estáticos, rotinas)
    index.ts               ponto de entrada (graceful shutdown)
    config.ts              variáveis de ambiente (validadas)
    auth.ts                sessões, credenciais de dispositivo, guards de permissão
    realtime.ts            Socket.IO (painel e player), comandos com confirmação
    routes/                auth, users, media (+upload em partes), playlists, devices, player, schedules, system
    services/              processamento de mídia, publicação, telões/agendamento, auditoria, configurações
    storage/               armazenamento local ou S3
  shared/                  tipos e regras compartilhadas (protocolo do player, agendamento)
  web/                     painel administrativo (React)
    pages/                 Visão Geral, Biblioteca, Playlists, Editor, Telões, Controle remoto, Programação, Histórico, Configurações
    components/  lib/
    player/index.html      página do player
  player/                  player do telão (motor de reprodução, cache, service worker)
  scripts/                 create-admin, banco local de desenvolvimento
tests/
  unit/  integration/  e2e/
scripts/windows/instalar-player.ps1   configuração do computador do telão
Dockerfile  docker-compose.yml  .env.example
```

## Executar (somente Node.js, sem Docker)

Pré-requisito: **Node.js 22 ou superior**. Nada mais precisa ser instalado: o PostgreSQL embutido, o FFmpeg e o FFprobe vêm pelo `npm install`.

```bash
npm install
cp .env.example .env        # ajuste ADMIN_EMAIL / ADMIN_PASSWORD e a senha do banco ANTES do 1º start
npm run build
npm start                   # sobe banco embutido + migrations + admin do .env + servidor
```

Acesse http://localhost:3000/admin e entre com o `ADMIN_EMAIL` e o `ADMIN_PASSWORD` do `.env`.
O player fica em http://localhost:3000/player.

Ao iniciar, o servidor:

1. sobe o PostgreSQL embutido (`EMBEDDED_DB=true`, dados em `.data/postgres`, acessível só em localhost) ou reaproveita um que já esteja rodando;
2. aplica as migrations pendentes (`AUTO_MIGRATE=true`);
3. cria o administrador do `.env` se ele ainda não existir;
4. atende painel, player e API na porta `PORT`.

**Instalação com duplo clique (Windows):**
- **`INSTALAR-SERVIDOR.cmd`:** pede permissão de Administrador; cria o `.env` (abre o Bloco de Notas), roda `npm install`/`build` se faltar, registra o servidor para iniciar com o Windows e reiniciar se cair, e libera a porta no firewall.
- **`INSTALAR-PLAYER.cmd`:** configura o telão em modo quiosque. Para usá-lo em outra máquina, copie-o junto com `scripts/windows/instalar-player.ps1`, os dois na mesma pasta.

Detalhes em [`scripts/windows/`](scripts/windows/).

**Desenvolvimento** (recarga automática): `npm run dev` sobe a API em :3000 (com o banco embutido) e o painel Vite em http://localhost:5173/admin.

### Comandos

| Comando | Função |
|---|---|
| `npm run dev` | API (recarga automática) + painel Vite |
| `npm run build` | Gera Prisma Client, frontend (`dist/web`) e servidor (`dist/server`) |
| `npm start` | Inicia o servidor compilado (banco embutido, migrations e admin do .env automáticos) |
| `npm run db:local` | Sobe só o PostgreSQL embutido (opcional; o `npm start` já faz isso) |
| `npm run db:migrate` | Cria uma nova migration a partir do `schema.prisma` (desenvolvimento) |
| `npm run db:deploy` | Aplica migrations pendentes |
| `npm run create-admin` | Cria um administrador ou redefine a senha dele |
| `npm run typecheck` | Verificação de tipos (servidor e frontend) |
| `npm test` | Testes unitários e de integração (sobe um PostgreSQL isolado automaticamente) |
| `npm run test:e2e` | Testes end-to-end no Chrome instalado (`E2E_CHANNEL=msedge` para Edge) |

> **Windows:** rode os testes pelo PowerShell ou CMD (`cd C:\...`). No Git Bash, a diferença `c:` × `C:` no caminho faz o Vitest carregar dois módulos e falhar com "failed to find the runner".

## Primeiro administrador

O administrador inicial vem do `.env`:

```ini
ADMIN_NAME=Administrador
ADMIN_EMAIL=admin@gazin.local
ADMIN_PASSWORD=Trocar-Esta-Senha-1      # troque antes do 1º start
ADMIN_RESET_PASSWORD=false
```

- Ele é criado no start **somente se ainda não existir**. Depois disso, a senha do `.env` **não** sobrescreve a do banco: troque-a pelo painel em **Configurações → Segurança**.
- Esqueceu a senha? Coloque a nova em `ADMIN_PASSWORD`, defina `ADMIN_RESET_PASSWORD=true`, reinicie e volte para `false`.
- A senha precisa ter 10 ou mais caracteres e 3 tipos (maiúsculas, minúsculas, números, símbolos). Se a do `.env` for fraca, o admin não é criado e o log mostra o motivo.
- Com a senha de exemplo, o servidor avisa no log.
- Também existe o comando `npm run create-admin` (interativo, senha oculta).

Os demais usuários (Administrador/Editor) são criados no painel em **Configurações → Usuários**.

## Cadastrar o computador do telão

1. No computador do telão, abra `https://SEU-SERVIDOR/player`. Um código aparece na tela (ex.: `K7M-4QX`).
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
  - Upload em partes, retomável, com progresso por arquivo e cancelamento.
  - O formato real é validado pela assinatura binária.
  - Miniaturas, duração e resolução são extraídas automaticamente.
  - Vídeos em codec incompatível (MOV, MKV, HEVC…) são convertidos para MP4/H.264, e o original é preservado.
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
  - Eventos WebSocket.
  - Reconciliação periódica por HTTP (a cada 60 s e a cada reconexão), sem depender só de eventos.
  - Número de versão sequencial por publicação.
- **Programação:**
  - Agendamentos por dias da semana, horário, período e prioridade, no fuso America/Sao_Paulo.
  - Janelas que atravessam a meia-noite são suportadas, e conflitos são bloqueados ou exibidos.
  - O servidor aplica os agendamentos sozinho, com o painel fechado.
- **Histórico:** auditoria persistente (usuário, telão, ação, detalhes) com filtros, sem senhas ou tokens.
- **Configurações:** padrões de reprodução, comportamento sem conteúdo, limite de upload, limiar de offline, usuários, troca de senha e sessões.

## Testes

Os testes executados nesta entrega estão descritos em [docs/ARQUITETURA.md#testes](docs/ARQUITETURA.md#testes),
com a relação de cada cenário obrigatório ao teste que o cobre.
