# GAZIN DISPLAY na Cloudflare — Implantação e operação

Este guia publica o GAZIN DISPLAY inteiro na Cloudflare. **Nenhum servidor próprio é necessário**: o computador do telão só precisa de um navegador.

```
 Seu computador (painel)            Cloudflare                                  Computador do telão
 ───────────────────────            ──────────────────────────────────────      ───────────────────
 https://…/admin  ───HTTPS──▶  Worker "gazin-display"                      ◀── https://…/player (Chrome/Edge)
                               ├─ Static Assets: painel e player                cache local (service worker)
 upload das partes ─HTTPS──▶  ├─ API /api/*  ──▶ D1 (banco de dados)
 (direto ao R2, URL           ├─ RealtimeHub (Durable Object, WebSocket) ◀─WSS── estado / comandos
  temporária assinada)        └─ Cron (a cada minuto): agendamentos e limpeza
              └──────────▶  R2 "gazin-display-media" (vídeos, imagens, miniaturas)
```

| Antes (versão 1) | Agora (Cloudflare) |
|---|---|
| Servidor Node.js (Fastify) sempre ligado | Worker (executa só quando há requisição) |
| PostgreSQL embutido | Cloudflare D1 |
| Disco local / S3 | Cloudflare R2 Standard |
| Socket.IO | Durable Object `RealtimeHub` com WebSocket Hibernation |
| `setInterval` (agendamentos, limpeza) | Cron Trigger (a cada minuto) |
| FFmpeg / Sharp no servidor | Análise da mídia no navegador do administrador |
| Admin criado pelo `.env` | `npm run create-admin -- --remote` |

---

## Parte A — Recursos necessários e o que pode gerar cobrança

| Serviço | Para quê | Franquia gratuita | Pode cobrar? |
|---|---|---|---|
| **Workers** (plano Free) | API, painel, player, cron | 100.000 requisições/dia, 10 ms de CPU por requisição. Arquivos estáticos (painel/player) não contam. | **Não** no plano Free: acima do limite, as requisições falham (não há cobrança). O plano **Workers Paid** custa US$ 5/mês e só é contratado se você escolher. |
| **Durable Objects** (SQLite) | Tempo real (painel ↔ telões) | 100.000 requisições/dia e 13.000 GB-s/dia | Não no plano Free (falha ao exceder). |
| **D1** | Banco de dados | 5 milhões de linhas lidas/dia, 100 mil gravadas/dia, 5 GB (500 MB por banco no Free) | Não no plano Free (falha ao exceder). |
| **R2 Standard** | Vídeos e imagens | 10 GB-mês, 1 milhão de operações Classe A e 10 milhões Classe B por mês; **saída (download) gratuita** | **Sim**: armazenamento acima de 10 GB (US$ 0,015/GB-mês) e operações acima da franquia. O R2 exige um meio de pagamento cadastrado para ser ativado. |

**Não habilite** Cloudflare Stream, Images, R2 Infrequent Access, Workers Paid ou Logpush: o sistema não precisa deles.

> O "limite de armazenamento" do sistema (Configurações → Sistema, padrão 30 GB) é uma regra **da aplicação**: novos envios são recusados acima dele. **Não é uma trava de faturamento** da Cloudflare — a Cloudflare não oferece um teto de gastos para o R2. Acompanhe a fatura (Parte G).

---

## Parte B — Configuração inicial (uma vez)

Pré-requisitos **apenas no seu computador** (não no telão): Node.js 22+ e Git. Rode os comandos na pasta do projeto, no PowerShell.

### B1. Dependências e login na Cloudflare

```powershell
npm install
npx wrangler login          # abre o navegador para autorizar sua conta (passo manual)
npx wrangler whoami         # mostra o Account ID — anote
```

### B2. Banco D1

```powershell
npx wrangler d1 create gazin-display
```

Copie o `database_id` exibido para `wrangler.jsonc` (campo `d1_databases[0].database_id`, hoje com zeros). Depois crie as tabelas:

```powershell
npm run db:migrate:remote
```

### B3. Bucket R2

1. No painel da Cloudflare, abra **R2** e ative o serviço (pede meio de pagamento — passo manual).
2. Crie o bucket:

```powershell
npx wrangler r2 bucket create gazin-display-media
```

Mantenha a classe **Standard** (padrão). Não habilite acesso público (`r2.dev`) nem domínio público: as mídias são entregues pelo Worker, só para usuários logados e telões autorizados.

### B4. Primeiro deploy (para obter o endereço)

```powershell
npm run deploy
```

O Wrangler mostra o endereço, por exemplo `https://gazin-display.SEU-SUBDOMINIO.workers.dev`. Em `wrangler.jsonc`, preencha:

```jsonc
"PUBLIC_URL": "https://gazin-display.SEU-SUBDOMINIO.workers.dev",
"R2_ACCOUNT_ID": "<Account ID do passo B1>",
```

(O Account ID não é segredo.)

### B5. Upload direto ao R2 (URLs temporárias assinadas)

Sem esta etapa o sistema funciona, mas as partes dos uploads passam pelo Worker (mais requisições). Com ela, o navegador envia cada parte **direto ao R2**, com uma URL assinada que vale **15 minutos** e serve **para uma única parte**.

1. Painel da Cloudflare → **R2** → **Manage R2 API Tokens** → **Create API token**.
   - Permissão: **Object Read & Write**.
   - Escopo: **somente o bucket `gazin-display-media`**.
   - Copie o **Access Key ID** e o **Secret Access Key** (o secret só é exibido uma vez).
2. Grave as chaves como **secrets do Worker** (o terminal pede o valor; ele não fica no código nem no navegador):

```powershell
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

3. CORS do bucket (permite que o painel envie as partes e leia a ETag). Edite `r2-cors.json`, troque a origem pelo seu endereço e aplique:

```powershell
npx wrangler r2 bucket cors set gazin-display-media --file r2-cors.json
```

### B6. Administrador inicial

```powershell
npm run create-admin -- --remote --email voce@gazin.com.br --name "Seu Nome"
```

A senha é pedida no terminal (oculta). Mínimo 10 caracteres com 3 tipos (maiúsculas, minúsculas, números, símbolos). O mesmo comando redefine a senha se você esquecê-la.

### B7. Publicar com a configuração final

```powershell
npm run deploy
```

Confira: `https://SEU-ENDERECO/api/health` deve responder `"status":"ok"` e `"upload":"direct"`. Em **Configurações → Sistema**, "Envio de arquivos" deve mostrar **Direto ao R2**.

### B8. (Opcional) Domínio próprio

Se a zona `gazin.com.br` estiver na Cloudflare: Workers & Pages → gazin-display → **Settings → Domains & Routes → Add → Custom domain** (ex.: `display.gazin.com.br`). Depois atualize `PUBLIC_URL`, a origem em `r2-cors.json` (reaplique o CORS) e publique de novo.

### B9. Dados da versão 1 (somente se houver)

O sistema antigo **não é alterado nem desligado** por este processo. Com o banco antigo acessível (servidor antigo ligado, ou `npm run db:local` na versão 1):

```powershell
$env:DATABASE_URL = "postgresql://postgres:SENHA@localhost:5433/gazin_display"   # o mesmo do .env antigo
$env:STORAGE_DIR  = "C:\caminho\da\versao1\storage"
$env:R2_ACCOUNT_ID = "..."; $env:R2_ACCESS_KEY_ID = "..."; $env:R2_SECRET_ACCESS_KEY = "..."
npm run migrate:legacy -- --out migracao.sql --upload
npx wrangler d1 execute DB --remote --file migracao.sql
```

- Faça isso com o D1 **vazio** (logo após `db:migrate:remote`, antes de usar o sistema novo).
- Os arquivos vão para o R2 com as mesmas chaves; reexecutar não reenvia o que já existe.
- Senhas antigas (Argon2id) continuam valendo e são convertidas no primeiro login. **No plano Free**, essa verificação única pode exceder o limite de CPU (erro 1102); nesse caso redefina a senha pelo painel (Configurações → Usuários) ou com `npm run create-admin -- --remote`.
- Os telões precisam ser **vinculados de novo** se o endereço mudou (o cookie do telão é do domínio antigo).
- Só desligue o servidor antigo depois de validar a nova versão.

---

## Parte C — Publicação

Arquitetura escolhida: **um único Worker com Static Assets** (painel, player e API no mesmo endereço). Motivos: um só deploy, mesmo domínio (cookies e CSRF simples, sem CORS na API), arquivos estáticos gratuitos e ilimitados.

```powershell
npm run deploy        # = vite build + wrangler deploy
```

- `npm run build` gera `dist/web` (painel e player).
- `wrangler deploy` publica o Worker, os assets, o Durable Object e o Cron.
- Cabeçalhos de segurança dos assets: `public/_headers`. Redirecionamentos: `public/_redirects`.

Desenvolvimento local (D1, R2 e Durable Object simulados no seu computador):

```powershell
npm run db:migrate:local
npm run create-admin -- --local --email admin@gazin.local
npm run dev           # http://localhost:5173/admin  (API em http://127.0.0.1:8787)
```

---

## Parte D — Endereços do sistema

| Uso | Endereço |
|---|---|
| Painel administrativo | `https://SEU-ENDERECO/admin` |
| Player do telão | `https://SEU-ENDERECO/player` |
| Verificação de saúde | `https://SEU-ENDERECO/api/health` |

---

## Parte E — Uso no telão

O computador do telão **não precisa** de Node.js, banco, Docker, terminal aberto nem acesso remoto.

1. Configure o Windows para não suspender nem desligar a tela (Configurações → Sistema → Energia → "Nunca").
2. Rode `INSTALAR-PLAYER.cmd` (copie junto com `scripts\windows\instalar-player.ps1`) e informe `https://SEU-ENDERECO/player`. O script cria um perfil próprio do Chrome/Edge e uma inicialização automática em **modo quiosque**, já com `--autoplay-policy=no-user-gesture-required`.
3. O telão mostra um código (ex.: `K7M-4QX`). No painel: **Telões → Vincular telão** → digite o código e o nome.
4. Publique uma playlist. O telão baixa as mídias, verifica a integridade e começa a tocar em loop.

Detalhes, configuração manual e solução de problemas: [docs/TELAO-WINDOWS.md](docs/TELAO-WINDOWS.md).

**Áudio e reprodução automática:** vídeos **sem som** sempre iniciam sozinhos. **Com som**, Chrome/Edge podem bloquear até haver um clique — o modo quiosque do script usa a opção que libera o autoplay; sem ela, o player continua sem som e mostra "Clique na tela para ativar o áudio". Isso é política do navegador e não pode ser contornado pelo sistema.

**Atualizações:** as alterações publicadas chegam pelo WebSocket em segundos; o player também confere a programação por HTTP a cada 60 s e a cada reconexão. A nova versão entra no intervalo entre mídias (ou imediatamente, se escolhido), sem recarregar a página.

**Sem internet:** o player continua tocando a última programação a partir do cache do navegador, inclusive após reiniciar o computador, **desde que todos os arquivos já tenham sido baixados**. O cache depende do espaço livre em disco (Chrome/Edge permitem uma fração do disco); não é garantido que 30 GB caibam — o painel mostra uso e cota do telão em Telões → detalhes.

---

## Parte F — Atualizações futuras

```powershell
git pull
npm install
npm run db:migrate:remote     # somente se houver novas migrations em /migrations
npm run deploy
```

- O deploy **não apaga** dados do D1 nem arquivos do R2.
- Telões e painéis abertos recebem a nova versão do player na próxima recarga (o player recarrega sozinho uma vez por dia, de madrugada).
- **Voltar uma versão do código:** `npx wrangler deployments list` e `npx wrangler rollback`.
- **Backup do banco:** `npx wrangler d1 export DB --remote --output backup.sql`. O D1 também tem *Time Travel* (restaurar a um ponto dos últimos 30 dias no plano pago / 7 dias no Free): `npx wrangler d1 time-travel restore DB --timestamp=...`.
- **Voltar ao sistema antigo (Node):** o código da versão 1 está preservado na tag `v1-node-fastify` e no branch `main`.

---

## Parte G — Custos, limites e acompanhamento

### Estimativa mensal

Premissas: 1 a 3 telões, painel usado em horário comercial, 10 a 30 GB de mídias, poucos uploads por semana. Preços de referência de novembro/2026.

| Item | 10 GB | 30 GB |
|---|---|---|
| R2 — armazenamento (10 GB grátis; US$ 0,015/GB-mês excedente) | US$ 0,00 | ≈ US$ 0,30 |
| R2 — operações (envios, leituras de vídeo) | dentro da franquia | dentro da franquia |
| R2 — download pelos telões | grátis | grátis |
| Workers, Durable Objects, D1, Cron (plano Free) | US$ 0,00 | US$ 0,00 |
| **Total estimado** | **≈ US$ 0** | **≈ US$ 0,30/mês** |

Opcional: **Workers Paid (US$ 5/mês)** só se o plano Free ficar curto (muitos telões, erro 1102 de CPU, ou mais de 100 mil requisições/dia). No Paid, aumente `PASSWORD_ITERATIONS` para `100000`.

Por que o consumo fica baixo:
- Painel e player são arquivos estáticos (não contam como requisições do Worker).
- Os telões baixam cada mídia **uma vez** e tocam do cache local; só baixam de novo o que mudou (verificado por SHA-256).
- O WebSocket hiberna: o "ping" é respondido pela Cloudflare sem acordar o Durable Object. Com o painel fechado, os telões enviam o estado a cada 30 s (5 s com o painel aberto).
- O Cron roda 1.440 vezes/dia (a cada minuto), com poucas consultas cada.

### Onde acompanhar

| O quê | Onde |
|---|---|
| Requisições, erros e CPU do Worker | Workers & Pages → gazin-display → **Metrics** (e **Logs**) |
| Armazenamento e operações do R2 | R2 → gazin-display-media → **Metrics** |
| Linhas lidas/gravadas e tamanho do D1 | Storage & Databases → D1 → gazin-display → **Metrics** |
| Durable Objects | Workers & Pages → gazin-display → Durable Objects |
| Fatura e uso faturável | **Manage Account → Billing → Billable Usage** |
| Uso pelo próprio sistema | Painel → Visão Geral (armazenamento x limite) e Configurações → Sistema |

### Alertas

- **Manage Account → Notifications → Add**: crie alertas de **Usage Based Billing** (avisa quando o uso faturável passar de um valor) para R2.
- No sistema: o painel avisa quando o armazenamento passa de 85% do limite lógico, e recusa envios acima dele.
- A Cloudflare **não oferece teto de gastos** para o R2: os alertas e o limite lógico da aplicação são as proteções disponíveis.

---

## Limitações conhecidas desta versão

- **Sem conversão de vídeo no servidor.** O Workers não executa FFmpeg. MOV, MKV, AVI e vídeos HEVC (H.265) são recusados com uma mensagem clara; converta para **MP4 (H.264)** antes de enviar (ex.: HandBrake). Vídeos já convertidos na versão 1 continuam funcionando.
- **Miniatura, duração, resolução e SHA-256 são calculados no navegador** de quem envia (antes eram calculados pelo FFprobe/Sharp no servidor). O servidor confere a assinatura real do arquivo (tipo), o tamanho e o codec informado. Arquivos muito grandes levam alguns segundos de "Analisando arquivo" antes do envio.
- **Plano Free:** 10 ms de CPU por requisição. Por isso o padrão de senha é PBKDF2 com 50 mil iterações; a primeira entrada de usuários migrados da versão 1 (Argon2) pode falhar no Free — redefina a senha.
- **Detecção de "offline":** um telão que perde a rede sem fechar a conexão pode levar até ~90 s para aparecer como desconectado.
