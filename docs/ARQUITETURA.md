# Arquitetura — GAZIN DISPLAY

## 1. Análise do exibidor original (`painel matriz.html`)

O exibidor atual é uma página HTML única, executada direto no computador do telão.

| Recurso do original | Como funcionava | No GAZIN DISPLAY |
|---|---|---|
| Vários vídeos e imagens | `<input type=file>` e `URL.createObjectURL` (temporário, perdido ao fechar) | Upload para o servidor com armazenamento persistente, e cache local persistente no telão |
| Reprodução em sequência e loop | Índice circular `show(index+1)` | Mantido (loop configurável por playlist) |
| Duração das imagens (30 s) | Um valor global | Padrão global de 30 s, por playlist e **por item** |
| Vídeos até o fim | Evento `ended` | Mantido, com watchdog de travamento |
| Ordem (↑ ↓), remover, clicar para exibir | Botões na lista | Arrastar e soltar no editor; "Exibir agora" no controle remoto |
| Pausar, avançar, parar | Botões e atalhos (Espaço, →) | Controle remoto pelo painel, com confirmação do telão |
| Contain / cover | `object-fit` | Por playlist e por telão (ajuste remoto persistente) |
| Áudio liga/desliga, mudo por padrão | `video.muted` | Mantido. Bloqueio de autoplay tratado (continua sem som e permite liberar com clique) |
| Tela cheia | `requestFullscreen` com clique | Modo quiosque do navegador (inicialização automática) |
| Erro em mídia | Pausava e pedia ação manual | Pula a mídia, registra no histórico, exibe o fallback se tudo falhar e tenta de novo |
| Barra de progresso e tempo restante | Na própria página | No painel (Visão Geral e Controle remoto), em tempo real |
| Transição suave (fade 200 ms) | Uma camada | Duas camadas com pré-carregamento: a próxima mídia só aparece quando está pronta (sem tela preta) |

Recurso não levado ao player: a interface com botões na própria tela. O escopo pede um player limpo, e esses controles agora ficam no painel.

## 2. Decisões técnicas (versão 2 — Cloudflare)

A versão 1 era um único serviço Node.js (Fastify + Socket.IO + PostgreSQL + FFmpeg) que precisava ficar ligado. A versão 2 mantém o painel, o player, os contratos da API e as regras de negócio, e troca apenas a infraestrutura:

| Componente | Versão 1 | Versão 2 | Por quê |
|---|---|---|---|
| Hospedagem | Fastify servindo SPA + API | **Um Worker com Static Assets** (`run_worker_first: /api/*`) | Um deploy, mesmo domínio (cookies e CSRF sem CORS), assets gratuitos |
| Rotas | Fastify | Hono (mesmos caminhos, corpos e códigos de erro) | Leve e nativo do Workers |
| Banco | PostgreSQL + Prisma | **D1** com SQL explícito, mesmos nomes de tabelas/colunas | Prisma no Workers pesa no bundle e na CPU (limite de 10 ms no Free) |
| Transações | Interativas | `batch()` atômico com condições de guarda no SQL | O D1 não tem transações interativas |
| Arquivos | Disco/S3, upload em blocos pelo servidor | **R2**: multipart, partes enviadas direto do navegador com URL assinada (15 min, uma parte) | O arquivo não atravessa o Worker nem esbarra no limite de 100 MB por requisição |
| Tempo real | Socket.IO | **Durable Object `RealtimeHub`** com WebSocket Hibernation | Mantém comandos com confirmação e estado ao vivo; hiberna sem tráfego |
| Rotinas | `setInterval` | **Cron Trigger** a cada minuto | Não há processo permanente |
| Processamento de mídia | FFprobe/FFmpeg/Sharp | **Navegador do administrador** (metadados, miniatura, SHA-256); o servidor valida assinatura, tamanho e codec | O Workers não executa binários. A conversão de vídeo deixa de existir (formatos incompatíveis são recusados) |
| Senhas | Argon2id (nativo) | **PBKDF2-SHA256** (Web Crypto); Argon2 legado aceito e convertido no 1º login | Argon2 em JS excede a CPU do plano Free |
| Limite de tentativas | Em memória | Tabela `RateLimit` no D1 | Várias instâncias do Worker |
| Admin inicial | `.env` | `npm run create-admin` (hash calculado localmente) | Não há `.env` no servidor |

**Limite de consultas por invocação:** o plano Free permite 50 consultas ao D1 por requisição (um `batch` conta como uma). Os serviços carregam dados em bloco (telões, agendamentos e versões em uma única chamada), sem consultas por telão.

**Upload:** `POST /api/uploads` (valida tamanho, formato, duplicidade por SHA-256 e limite de armazenamento; cria o multipart) → para cada parte, `POST …/parts/:n/url` devolve a URL assinada, o navegador faz `PUT` direto no R2 e confirma a ETag em `POST …/parts/:n` → miniatura/prévia em `PUT …/derivative/:kind` → `POST …/complete` conclui o multipart, confere o objeto no R2 (tamanho e assinatura binária) e só então cria a mídia. Uploads abandonados expiram em 24 h; o cron aborta o multipart e libera o espaço reservado. Sem credenciais S3 (desenvolvimento), as partes passam pelo Worker em stream (`PUT …/parts/:n`).

**Entrega das mídias:** sempre pelo Worker, autenticada (sessão do painel ou credencial do telão), com `Range`/206 em stream direto do R2 — o Worker nunca carrega o arquivo em memória. O bucket não é público. O telão baixa cada arquivo uma vez e o reproduz do Cache Storage.

## 3. Modelo de dados

`User`, `Session`, `Media`, `UploadSession`, `Playlist`, `PlaylistItem`, `PlaylistVersion` (snapshot imutável em JSON + `mediaIds`),
`DisplayDevice`, `DeviceCredential`, `PairingRequest`, `DeviceCommand`, `Schedule`, `AuditLog`, `AppSetting`.

- **Rascunho × publicado:** a `Playlist` e seus `PlaylistItem` são o rascunho editável, com `revision` para controle de concorrência otimista. Cada publicação cria uma `PlaylistVersion` com número sequencial único por playlist (`@@unique([playlistId, number])`). O telão só lê versões.
- **Telão:**
  - `publishedVersionId` é a programação padrão;
  - `effectiveVersionId` é o que deve tocar agora (padrão ou agendamento, calculado pelo servidor);
  - `reportedVersionId` é o que o telão confirmou estar tocando.
- **Exclusão de mídia:**
  - bloqueada se a mídia estiver em qualquer versão efetiva, reportada ou padrão, ou na última versão de uma playlist com agendamento ativo;
  - se estiver só em rascunhos, exige confirmação (é removida deles).

## 4. Sincronização

```
Admin publica ──▶ Worker grava PlaylistVersion N (D1) ──▶ recalcula a versão efetiva de cada telão
                                                       └─▶ RealtimeHub envia "sync" (WebSocket) com o manifest
Player: recebe manifest ──▶ baixa e verifica (SHA-256) os arquivos ausentes no Cache Storage
        ──▶ continua tocando a versão atual ──▶ troca no próximo intervalo (ou imediatamente)
        ──▶ reporta estado a cada 5 s com painel aberto / 30 s sem painel (versão, item, tempo, cache, erros)
```

- **Não depende só do WebSocket:** o player consulta `GET /api/player/manifest` a cada 60 s e a cada reconexão; o RealtimeHub também envia o manifest atual sempre que um telão se conecta.
- **Hibernação:** o "ping" dos clientes (a cada 25 s) é respondido pela própria Cloudflare (`setWebSocketAutoResponse`), sem acordar o Durable Object. O estado ao vivo fica em memória e é gravado no D1 em mudanças ou a cada 15 s.
- **Comandos remotos:** o Worker chama o RealtimeHub (RPC), que envia o comando ao telão e aguarda a confirmação (`ack`) por até 10 s. Com o telão offline, retorna `409 DEVICE_OFFLINE`; sem resposta, `504 DEVICE_TIMEOUT`. Ajustes de áudio e tela são persistidos e aplicados na reconexão.
- **Desconexão:** ao fechar o último WebSocket do telão, o RealtimeHub agenda um *alarm*; se ele não voltar dentro do limite configurado, a desconexão vai para o histórico.
- **Agendamentos:** calculados pelo cron a cada minuto e em cada consulta de manifest (fuso America/Sao_Paulo).

## 5. Player e funcionamento offline

- **Service worker** (`/player/sw.js`, escopo `/player/`):
  - guarda a página e os scripts do player;
  - entrega as mídias a partir do **Cache Storage** com suporte a `Range` (necessário para `<video>`).
- O **manifest** da última versão aplicada e a posição atual ficam no `localStorage`. Ao reiniciar, a reprodução começa **antes** de contatar o servidor.
- **Troca segura de versão:**
  1. Os arquivos da nova versão são baixados e verificados por SHA-256.
  2. Só então a versão é aplicada.
  3. Se faltar espaço, primeiro são removidos do cache os arquivos que não pertencem nem à versão atual nem à nova.
  4. Se ainda faltar espaço, a versão atual continua no ar e o erro aparece no painel e no histórico.
  5. Os arquivos antigos só são apagados depois que a nova versão entra no ar.
- O player solicita armazenamento persistente (`navigator.storage.persist()`) e reporta uso e cota.

### Limitações reais

- O **cache offline exige HTTPS** (ou `localhost`). O endereço da Cloudflare já é HTTPS.
- A cota de armazenamento do Chrome/Edge é uma fração do disco livre (normalmente até ~60% por origem). Playlists maiores que a cota não ficam totalmente offline: a versão anterior continua no ar e o painel alerta.
- Se a Cloudflare ficar inacessível **e** o navegador for reiniciado **antes** da primeira sincronização completa, não há o que reproduzir.
- Se o usuário apagar os dados do navegador (ou o perfil dedicado), a credencial e o cache são perdidos e é preciso vincular de novo.
- Autoplay **com áudio** depende da política do navegador. Use a flag do modo quiosque (docs/TELAO-WINDOWS.md) ou um clique do operador.

## 6. Segurança

- Senhas com **PBKDF2-SHA256** (50 mil iterações no plano Free, até 100 mil no Paid; atualizadas automaticamente no login). Não há credencial padrão. Política mínima de senha. Login com tempo constante para usuários inexistentes.
- Sessões em cookie `HttpOnly`, `SameSite=Lax` e `Secure` (HTTPS). O token é guardado só como hash SHA-256, com expiração deslizante. Logout e troca de senha invalidam as sessões no servidor e desconectam o WebSocket.
- **CSRF:** requisições que alteram estado exigem o cabeçalho `X-GD-CSRF` (a API não habilita CORS) e, se houver `Origin`, ela precisa ser igual ao host ou a `PUBLIC_URL`. A mesma checagem de origem vale para o WebSocket.
- **Limite de tentativas** (D1): login (20 / 5 min por IP), vinculação, comandos e troca de senha.
- **Autorização no servidor:** Admin/Editor e "pode publicar". O telão usa uma credencial própria (`gd_device`), com acesso apenas a `/api/player/*` e somente às mídias das versões ligadas a ele. O Durable Object só aceita conexões já autenticadas pelo Worker.
- **R2:** bucket privado. As chaves da API S3 ficam em *secrets* do Worker; o navegador recebe apenas URLs assinadas de uma parte, válidas por 15 minutos. CORS do bucket restrito à origem do sistema e ao método `PUT`.
- **Uploads:** assinatura binária (`file-type`) verificada no R2 após o envio; chaves geradas pelo servidor (nomes de arquivo nunca usados como caminho); limite por arquivo e limite lógico de armazenamento.
- Cabeçalhos: CSP restritiva, `X-Frame-Options: DENY`, `nosniff`, HSTS (`public/_headers`) e `Cache-Control: no-store` na API.
- A auditoria remove automaticamente campos com nomes sensíveis (senha, token, cookie, hash).

## Testes

Executados nesta entrega (Windows 11, Node 24, Wrangler 4.165 com D1/R2/Durable Object locais, Chrome estável):

- `npm run typecheck`: sem erros (Worker, frontend e scripts/testes).
- `npm test`: **51 testes em 7 arquivos, todos passando**, contra o Worker real em `wrangler dev` (D1 e R2 locais, Durable Object, cron).
- `npm run test:e2e`: **9 testes end-to-end, todos passando** no Chrome real (painel + player em contextos separados, upload real pelo navegador).
- `wrangler deploy --dry-run`: bundle de 1,19 MiB (221 KiB gzip), abaixo do limite de 3 MiB do plano Free.

| Cenário | Onde |
|---|---|
| Login válido/inválido, sessões, logout, troca de senha, último admin | `integration/auth` · e2e "login" |
| Rotas protegidas, CSRF, permissões de Editor | `integration/auth` |
| Senha Argon2 da versão 1 aceita e convertida | `integration/auth` |
| Limite de tentativas (429) | `integration/auth` |
| Upload de imagem e de vídeo em várias partes (multipart R2) | `integration/media` · e2e "biblioteca" |
| Range/206, HEAD, 416, integridade (SHA-256) | `integration/media`, `integration/publish-sync` |
| Arquivo inválido, formatos que exigem conversão, HEVC | `integration/media` |
| Upload incompleto, parte errada/fora de ordem, cancelamento, upload de outro usuário | `integration/media` |
| Upload abandonado expirado (limpeza pelo cron) | `integration/schedules-cron` |
| Duplicidade e limite lógico de armazenamento | `integration/media` |
| Exclusão: mídia em rascunho e mídia em uso | `integration/media`, `integration/publish-sync` |
| Playlists, reordenação, revisão desatualizada, duplicação | `integration/publish-sync` · e2e "playlist" |
| Publicação → player recebe pelo WebSocket; manifest HTTP | `integration/publish-sync` · e2e "telão" |
| Publicações simultâneas (versões 1..5) | `integration/publish-sync` |
| Imagem pelo tempo configurado, vídeo até o fim, loop | e2e "player" |
| Atualização durante a reprodução | `integration/publish-sync` · e2e "atualização" |
| Comandos: confirmado, recusado, timeout, offline (409/202) | `integration/devices` · e2e "controle remoto" |
| Revogação, credencial forjada/expirada, troca de computador | `integration/devices`, `integration/schedules-cron` · e2e "revogação" |
| Sem rede, recarga offline e reconexão | e2e "sem rede" |
| Agendamentos (fuso, meia-noite, prioridade, conflitos) e cron | `unit/schedule`, `integration/schedules-cron` |
| URLs pré-assinadas (escopo, validade, sem segredo) | `unit/security-r2` |

### Não testado nesta entrega (depende da conta Cloudflare)

- Deploy real, D1/R2/Durable Object em produção e o Cron em produção.
- **Upload direto ao R2** com URL assinada: CORS do bucket, leitura da ETag pelo navegador e conclusão do multipart com essas ETags (o código tenta o binding e, se recusar, a API S3). Testados apenas o formato da URL (unitário) e o modo pelo Worker (integração/e2e).
- Consumo real de CPU por requisição no plano Free (o PBKDF2 foi medido localmente: ~5 ms com 50 mil iterações).
- Script `migrate-legacy` contra um banco real da versão 1: não havia dados da versão 1 nesta máquina, e o módulo de armazenamento da versão 1 nunca foi versionado (o script procura os arquivos nos caminhos mais prováveis e lista os que não encontrar).
- Edge, resolução 4K física e operação contínua por semanas.
