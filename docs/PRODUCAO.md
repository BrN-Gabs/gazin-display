# Implantação em produção

O servidor do GAZIN DISPLAY é um único processo Node.js. Ele atende o painel, o player, a API e o WebSocket, e executa os agendamentos. Ele depende de:

- **PostgreSQL** (12+; testado com 18 embutido e 17 no Compose);
- **armazenamento persistente** para as mídias: disco/volume local **ou** bucket S3 compatível;
- **FFmpeg/FFprobe** (incluídos na imagem Docker e no `npm install` via `ffmpeg-static`).

O sistema não depende de nenhum serviço pago nem do computador pessoal do administrador.
O servidor funciona com o painel fechado.

## Opção A — Somente Node.js (sem Docker)

No servidor (Windows ou Linux) com Node.js 22+:

```bash
npm ci
cp .env.example .env   # NODE_ENV=production, PUBLIC_URL, ADMIN_*, senha do banco (antes do 1º start!)
npm run build
npm start
```

Com `EMBEDDED_DB=true`, o próprio servidor mantém o PostgreSQL em `EMBEDDED_DB_DIR` (escuta só em localhost), aplica as migrations e cria o admin do `.env`.
No Windows, `scripts/windows/instalar-servidor.ps1` registra uma tarefa que inicia o servidor com o sistema e o reinicia se cair (logs em `logs/servidor.log`).

**Backup:** pare o servidor e copie `.data/postgres` e `STORAGE_DIR`. Para backup a quente, use o `pg_dump` de qualquer instalação do PostgreSQL contra a `DATABASE_URL`.

> Para acesso só por `http://` na rede interna, mantenha `COOKIE_SECURE=auto` com `PUBLIC_URL=http://...` (os cookies não podem ser `Secure` sem HTTPS). Lembre que, sem HTTPS, o cache offline do player não funciona.

## Opção B — Docker Compose (alternativa)

Em um servidor Linux da rede interna ou numa VPS:

```bash
git clone <repositório> gazin-display && cd gazin-display
cp .env.example .env
# edite .env: POSTGRES_PASSWORD (forte), PUBLIC_URL=https://display.gazin.com.br, TRUST_PROXY=true, COOKIE_SECURE=true
docker compose up -d --build
docker compose exec app node dist/server/scripts/create-admin.js
curl http://localhost:3000/api/health
```

- As migrations são aplicadas automaticamente a cada start (`npm run start:prod`).
- Volumes: `pgdata` (banco) e `media` (`/data/storage`, com mídias, miniaturas e uploads em andamento).
- Health check do container: `GET /api/health`. Liveness simples: `GET /api/health/live`.
- Logs em JSON (Pino) na saída padrão: `docker compose logs -f app`.

Atualizar a versão: `git pull && docker compose up -d --build`.

## Opção C — Node.js com PostgreSQL externo

```bash
npm ci
npm run build
# .env com NODE_ENV=production, EMBEDDED_DB=false, DATABASE_URL de um PostgreSQL real, STORAGE_DIR persistente
npm start
```

Mantenha o processo ativo com um gerenciador de serviços: **systemd** no Linux, **NSSM** ou "serviço do Windows" no Windows, ou PM2.

## HTTPS (obrigatório em produção)

O HTTPS é obrigatório por dois motivos:

- Os cookies `Secure` exigem HTTPS.
- O **cache offline do player** (service worker e Cache Storage) só funciona em HTTPS.

Coloque um proxy reverso na frente da porta 3000, por exemplo o **Caddy**, que emite o certificado automaticamente:

```
display.gazin.com.br {
  reverse_proxy 127.0.0.1:3000
  request_body {
    max_size 64MB   # cada parte do upload tem UPLOAD_CHUNK_MB (padrão 8 MB)
  }
}
```

Exemplo com **Nginx**:

```nginx
server {
  listen 443 ssl http2;
  server_name display.gazin.com.br;
  # ssl_certificate ...; ssl_certificate_key ...;
  client_max_body_size 64m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WebSocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
    proxy_buffering off;                          # vídeos com Range
  }
}
```

Com proxy, defina `TRUST_PROXY=true`. Isso garante o IP real para rate limiting e auditoria.
Para uso só na rede interna, um certificado da CA corporativa instalado nos computadores também serve.

## Armazenamento

- **Local (padrão):** `STORAGE_DRIVER=local` e `STORAGE_DIR` apontando para um disco persistente/volume. Faça backup desse diretório.
- **S3 compatível** (AWS S3, MinIO, Wasabi, Backblaze B2, Cloudflare R2…): `STORAGE_DRIVER=s3` e `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, além de `S3_ENDPOINT` e `S3_FORCE_PATH_STYLE=true` para MinIO e similares. O bucket deve ser **privado**: o servidor faz proxy das mídias com Range e checagem de permissão. Mesmo com S3, `STORAGE_DIR` continua sendo usado para uploads em andamento e processamento, então reserve espaço para os maiores arquivos.
- O driver S3 foi implementado com o SDK oficial, mas **não foi testado contra um bucket real** nesta entrega. Valide em homologação.

## Acesso remoto seguro

- **Somente rede interna/VPN:** o mais simples. Publique o servidor na rede corporativa e acesse o painel pela VPN.
- **Domínio público autorizado** (`display.gazin.com.br`): HTTPS obrigatório. Considere restringir `/admin` por IP/VPN no proxy, deixando `/player` e `/api/player` acessíveis aos telões. O login já tem rate limiting e senhas Argon2id.
- Mantenha o servidor e o PostgreSQL atualizados e **não exponha a porta do PostgreSQL**.

## Backup e restauração

- Banco: `docker compose exec db pg_dump -U gazin gazin_display > backup.sql` (agende diariamente).
- Mídias: copie o volume `media` (ou habilite versionamento no bucket S3).
- Restaurar: `psql` com o dump e restaure os arquivos no mesmo caminho/bucket.

## Variáveis importantes

Veja a lista completa comentada em [`.env.example`](../.env.example). Em produção:

| Variável | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `PUBLIC_URL` | URL pública (`https://display.gazin.com.br`), usada na proteção CSRF/origem |
| `COOKIE_SECURE` | `true` (ou `auto`) |
| `TRUST_PROXY` | `true` atrás de proxy |
| `MAX_UPLOAD_MB` | limite absoluto por arquivo (padrão 20 GB). O operacional fica em Configurações |
| `SESSION_TTL_HOURS` / `DEVICE_TOKEN_TTL_DAYS` | duração da sessão do painel / credencial dos telões |

## Escalabilidade

O servidor foi feito para **uma instância** (os sockets dos telões e a fila de processamento de vídeo ficam em memória).
Isso atende com folga dezenas de telões. Para várias instâncias, seriam necessários o adaptador Redis do Socket.IO e uma fila externa de processamento.
