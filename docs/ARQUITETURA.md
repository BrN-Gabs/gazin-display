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

## 2. Decisões técnicas

**Um único serviço Node.js (Fastify + Socket.IO) que também serve o painel React (Vite) e o player.**
O escopo sugeria Next.js. Optei por Fastify + SPA pelos motivos abaixo:

- O sistema precisa de um processo **sempre ativo**: WebSocket persistente com os telões, agendador interno, fila de processamento de vídeo e uploads de vários GB em streaming. Isso exigiria um servidor customizado fora do modelo do Next.js e não roda em plataformas serverless.
- Um processo e um container são mais simples de operar e de diagnosticar.
- O player é TypeScript puro (sem React), o que o deixa leve e estável para rodar semanas sem parar.

Os componentes de UI seguem o padrão do shadcn/ui (Tailwind + componentes próprios em `src/web/components/ui.tsx`), sem dependência de runtime externa.

**Banco:** PostgreSQL + Prisma 7 (adaptador `pg`). Migrations em `prisma/migrations`.

**Arquivos:** nunca ficam no navegador do administrador. O upload é feito em partes (8 MB) para `STORAGE_DIR/tmp/uploads`. Ao concluir:

1. validação da assinatura real do arquivo;
2. processamento (FFprobe/FFmpeg/Sharp);
3. movimentação **atômica** para o armazenamento final (local ou S3).

Um upload interrompido não afeta os arquivos já armazenados.

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
Admin publica ──▶ servidor grava PlaylistVersion N ──▶ recalcula versão efetiva de cada telão
                                                     └─▶ evento "sync" (WebSocket) com o manifest
Player: recebe manifest ──▶ baixa e verifica (SHA-256) os arquivos ausentes no Cache Storage
        ──▶ continua tocando a versão atual ──▶ troca no próximo intervalo (ou imediatamente)
        ──▶ reporta estado a cada 5 s (versão, item, tempo, cache, erros)
```

- **Não depende só de WebSocket:** o player consulta `GET /api/player/manifest` a cada 60 s, a cada reconexão e em cada `connect`. O servidor também envia o manifest atual sempre que um telão se conecta.
- **Comandos remotos:** `emitWithAck` com timeout de 10 s. O painel só mostra sucesso com a resposta real do dispositivo. Com o telão offline, retorna `409 DEVICE_OFFLINE`. Ajustes de áudio e tela são persistidos e aplicados na reconexão.
- **Agendamentos:** calculados no servidor a cada 15 s e em cada consulta de manifest (fuso America/Sao_Paulo).

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

- O **cache offline exige HTTPS** (ou `localhost`). Em HTTP simples, o player funciona apenas online e o painel avisa ("indisponível (requer HTTPS)").
- A cota de armazenamento do Chrome/Edge é uma fração do disco livre (normalmente até ~60% por origem). Playlists maiores que a cota não ficam totalmente offline: a versão anterior continua no ar e o painel alerta.
- Se o servidor ficar indisponível **e** o navegador for reiniciado **antes** da primeira sincronização completa, não há o que reproduzir.
- Se o usuário apagar os dados do navegador (ou o perfil dedicado), a credencial e o cache são perdidos e é preciso vincular de novo.
- Autoplay **com áudio** depende da política do navegador. Use a flag do modo quiosque (docs/TELAO-WINDOWS.md) ou um clique do operador.
- O servidor foi feito para uma instância (veja docs/PRODUCAO.md).

## 6. Segurança

- Senhas com **Argon2id**; não há credencial padrão (primeiro admin via CLI). Política mínima de senha. Login com tempo constante para usuários inexistentes.
- Sessões em cookie `HttpOnly`, `SameSite=Lax` e `Secure` em produção. O token é guardado só como hash SHA-256, com expiração deslizante. O logout e a troca de senha invalidam sessões no servidor.
- **CSRF:**
  - todas as requisições que alteram estado exigem o cabeçalho `X-GD-CSRF`, que um site externo não consegue enviar sem CORS (o servidor não habilita CORS);
  - se houver `Origin`, ela precisa ser igual ao host ou a `PUBLIC_URL`;
  - a mesma checagem de origem vale para o WebSocket.
- Rate limiting: login (20 / 5 min por IP), vinculação, comandos e troca de senha.
- **Autorização no servidor:** Admin/Editor e a permissão "pode publicar". O telão usa uma credencial própria (`gd_device`), com acesso apenas às rotas `/api/player/*` e somente às mídias das versões ligadas a ele.
- **Uploads:**
  - validação da assinatura binária (`file-type`), decodificação completa (Sharp/FFprobe) e conversão de formatos;
  - nomes de arquivo **nunca** usados em caminhos (chaves geradas pelo servidor) e proteção contra path traversal;
  - limite configurável.
- Cabeçalhos: CSP restritiva, `X-Frame-Options: DENY`, `nosniff`, HSTS em produção e `Cache-Control: no-store` na API.
- A auditoria remove automaticamente campos com nomes sensíveis (senha, token, cookie, hash).

## Testes

Executados nesta entrega (Windows 11, Node 26, PostgreSQL 18 embutido, Chrome estável):

- `npm run typecheck`: sem erros (servidor e frontend).
- `npm test`: **53 testes, 7 arquivos, todos passando** (unitários e integração com PostgreSQL real, uploads reais e FFmpeg).
- `npm run test:e2e`: **9 testes end-to-end, todos passando** no Chrome real (painel + player em contextos separados).

| # | Cenário obrigatório | Onde |
|---|---|---|
| 1 | Login válido e inválido | `integration/auth` · e2e "login" |
| 2 | Rotas protegidas sem autenticação | `integration/auth` |
| 3 | Upload de imagem | `integration/media` · e2e "biblioteca" |
| 4 | Upload de vídeo | `integration/media` (inclui Range e conversão de codec) · e2e |
| 5 | Rejeição de arquivo inválido | `integration/media` (texto com extensão .jpg, executável .png) |
| 6 | Criação de playlist | `integration/publish-sync` · e2e "playlist" |
| 7 | Reordenação dos itens | `integration/publish-sync` · e2e (arrastar e soltar) |
| 8 | Publicação de playlist | `integration/publish-sync` · e2e |
| 9 | Recebimento da publicação no player | `integration/publish-sync` (socket) · e2e |
| 10 | Imagem pelo tempo configurado | e2e "player" (3 s medidos) |
| 11 | Vídeo até o fim | e2e "player" (vídeo de 3 s medido) |
| 12 | Retorno ao primeiro item | e2e "player" |
| 13 | Atualização durante a reprodução | `integration/publish-sync` · e2e "atualização" (sem interromper; nova mídia na posição) |
| 14 | Desconexão temporária | `integration/devices` (status Reconectando) · e2e "sem rede" |
| 15 | Reconexão automática | `integration/devices` (reconciliação) · e2e "sem rede" |
| 16 | Reinicialização do navegador | e2e "sem rede": página recarregada **offline** volta a tocar do cache |
| 17 | Comandos remotos | `integration/devices` (todos os tipos, recusa, timeout) · e2e "controle remoto" |
| 18 | Exclusão protegida de mídia em uso | `integration/publish-sync` |
| 19 | Player offline | e2e "sem rede" |
| 20 | Dispositivo não autorizado | `integration/devices` (HTTP, socket, credencial forjada, revogação) · e2e "revogação" |
| 21 | Agendamento de playlist | `unit/schedule` (fuso, meia-noite, prioridade, conflitos) · `integration/schedules` |
| 22 | Publicações simultâneas e versões | `integration/publish-sync` (5 publicações paralelas → v3..v7) e revisão desatualizada |

### Não testado nesta entrega

- Imagem Docker e `docker-compose.yml`: Docker não está instalado na máquina de desenvolvimento. Os arquivos foram escritos, mas não executados.
- Driver S3 contra um bucket real.
- Script `scripts/windows/instalar-player.ps1`: a sintaxe foi validada, mas ele não foi executado (cria uma tarefa agendada na máquina).
- Edge (`E2E_CHANNEL=msedge`), resolução 4K física e operação contínua por semanas: os mecanismos existem (watchdog, recarga diária, reconciliação), mas exigem homologação no telão real.
