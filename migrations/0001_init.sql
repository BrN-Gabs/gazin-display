-- GAZIN DISPLAY — esquema inicial do Cloudflare D1 (SQLite)
--
-- Mantém os mesmos nomes de tabelas e colunas do modelo Prisma/PostgreSQL da versão 1
-- (facilita a migração dos dados existentes — veja scripts/migrate-legacy.ts).
-- Conversões: UUID → TEXT; DateTime → TEXT ISO-8601 (UTC); BigInt → INTEGER;
-- Boolean → INTEGER (0/1); Json e arrays (String[] / Int[]) → TEXT com JSON.
-- O D1 aplica as chaves estrangeiras (ON DELETE CASCADE / SET NULL / RESTRICT) por padrão.

CREATE TABLE "User" (
  "id"                TEXT PRIMARY KEY NOT NULL,
  "name"              TEXT NOT NULL,
  "email"             TEXT NOT NULL UNIQUE,
  "username"          TEXT UNIQUE,
  "passwordHash"      TEXT NOT NULL,
  "role"              TEXT NOT NULL DEFAULT 'EDITOR' CHECK ("role" IN ('ADMIN', 'EDITOR')),
  "canPublish"        INTEGER NOT NULL DEFAULT 1,
  "active"            INTEGER NOT NULL DEFAULT 1,
  "createdAt"         TEXT NOT NULL,
  "updatedAt"         TEXT NOT NULL,
  "lastLoginAt"       TEXT,
  "passwordChangedAt" TEXT
);

CREATE TABLE "Session" (
  "id"         TEXT PRIMARY KEY NOT NULL,
  "tokenHash"  TEXT NOT NULL UNIQUE,
  "userId"     TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "createdAt"  TEXT NOT NULL,
  "lastSeenAt" TEXT NOT NULL,
  "expiresAt"  TEXT NOT NULL,
  "ip"         TEXT,
  "userAgent"  TEXT
);
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

CREATE TABLE "Media" (
  "id"               TEXT PRIMARY KEY NOT NULL,
  "name"             TEXT NOT NULL,
  "description"      TEXT,
  "originalFilename" TEXT NOT NULL,
  "type"             TEXT NOT NULL CHECK ("type" IN ('IMAGE', 'VIDEO')),
  "status"           TEXT NOT NULL DEFAULT 'PROCESSING' CHECK ("status" IN ('PROCESSING', 'READY', 'FAILED')),
  "mimeType"         TEXT NOT NULL,
  "sizeBytes"        INTEGER NOT NULL,
  "originalSize"     INTEGER,
  "durationMs"       INTEGER,
  "width"            INTEGER,
  "height"           INTEGER,
  "videoCodec"       TEXT,
  "checksum"         TEXT,
  "storageKey"       TEXT,
  "originalKey"      TEXT,
  "thumbnailKey"     TEXT,
  "previewKey"       TEXT,
  "transcoded"       INTEGER NOT NULL DEFAULT 0,
  "error"            TEXT,
  "uploadedById"     TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "createdAt"        TEXT NOT NULL,
  "updatedAt"        TEXT NOT NULL
);
CREATE INDEX "Media_createdAt_idx" ON "Media"("createdAt");
CREATE INDEX "Media_type_status_idx" ON "Media"("type", "status");
CREATE INDEX "Media_checksum_idx" ON "Media"("checksum");

-- Upload em partes direto ao R2 (multipart). A mídia só é criada após a confirmação do objeto no R2.
CREATE TABLE "UploadSession" (
  "id"            TEXT PRIMARY KEY NOT NULL,
  "userId"        TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "filename"      TEXT NOT NULL,
  "declaredMime"  TEXT,
  "totalBytes"    INTEGER NOT NULL,
  "receivedBytes" INTEGER NOT NULL DEFAULT 0,
  "status"        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'COMPLETED', 'CANCELLED', 'FAILED')),
  "mediaId"       TEXT REFERENCES "Media"("id") ON DELETE SET NULL,
  "error"         TEXT,
  "createdAt"     TEXT NOT NULL,
  "updatedAt"     TEXT NOT NULL,
  "expiresAt"     TEXT NOT NULL,
  -- novos (Cloudflare): ID reservado para a mídia, chave do objeto, upload multipart do R2 e tamanho da parte
  "plannedMediaId" TEXT NOT NULL,
  "storageKey"    TEXT NOT NULL,
  "r2UploadId"    TEXT NOT NULL,
  "chunkBytes"    INTEGER NOT NULL,
  "checksum"      TEXT,
  "thumbnailKey"  TEXT,
  "previewKey"    TEXT
);
CREATE INDEX "UploadSession_status_expiresAt_idx" ON "UploadSession"("status", "expiresAt");

CREATE TABLE "UploadPart" (
  "uploadId"   TEXT NOT NULL REFERENCES "UploadSession"("id") ON DELETE CASCADE,
  "partNumber" INTEGER NOT NULL,
  "etag"       TEXT NOT NULL,
  "size"       INTEGER NOT NULL,
  "createdAt"  TEXT NOT NULL,
  PRIMARY KEY ("uploadId", "partNumber")
);

CREATE TABLE "Playlist" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "settings"    TEXT NOT NULL DEFAULT '{}',
  "revision"    INTEGER NOT NULL DEFAULT 1,
  "createdById" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "createdAt"   TEXT NOT NULL,
  "updatedAt"   TEXT NOT NULL
);

CREATE TABLE "PlaylistItem" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "playlistId"  TEXT NOT NULL REFERENCES "Playlist"("id") ON DELETE CASCADE,
  "mediaId"     TEXT NOT NULL REFERENCES "Media"("id") ON DELETE RESTRICT,
  "position"    INTEGER NOT NULL,
  "durationSec" INTEGER,
  "settings"    TEXT
);
CREATE INDEX "PlaylistItem_playlistId_position_idx" ON "PlaylistItem"("playlistId", "position");
CREATE INDEX "PlaylistItem_mediaId_idx" ON "PlaylistItem"("mediaId");

CREATE TABLE "PlaylistVersion" (
  "id"              TEXT PRIMARY KEY NOT NULL,
  "playlistId"      TEXT NOT NULL REFERENCES "Playlist"("id") ON DELETE CASCADE,
  "number"          INTEGER NOT NULL,
  "snapshot"        TEXT NOT NULL,
  "sourceRevision"  INTEGER NOT NULL,
  "itemCount"       INTEGER NOT NULL,
  "totalDurationMs" INTEGER NOT NULL DEFAULT 0,
  "totalBytes"      INTEGER NOT NULL DEFAULT 0,
  "publishedAt"     TEXT NOT NULL,
  "publishedById"   TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "mediaIds"        TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX "PlaylistVersion_playlistId_number_key" ON "PlaylistVersion"("playlistId", "number");
CREATE INDEX "PlaylistVersion_publishedAt_idx" ON "PlaylistVersion"("publishedAt");

CREATE TABLE "DisplayDevice" (
  "id"                 TEXT PRIMARY KEY NOT NULL,
  "name"               TEXT NOT NULL,
  "identifier"         TEXT NOT NULL UNIQUE,
  "location"           TEXT,
  "settings"           TEXT NOT NULL DEFAULT '{}',
  "playlistId"         TEXT REFERENCES "Playlist"("id") ON DELETE SET NULL,
  "publishedVersionId" TEXT REFERENCES "PlaylistVersion"("id") ON DELETE SET NULL,
  "applyMode"          TEXT NOT NULL DEFAULT 'next',
  "effectiveVersionId" TEXT,
  "effectiveSource"    TEXT,
  "reportedVersionId"  TEXT,
  "lastState"          TEXT,
  "lastError"          TEXT,
  "lastSeenAt"         TEXT,
  "connectedAt"        TEXT,
  "disconnectedAt"     TEXT,
  "createdAt"          TEXT NOT NULL,
  "updatedAt"          TEXT NOT NULL
);

CREATE TABLE "DeviceCredential" (
  "id"         TEXT PRIMARY KEY NOT NULL,
  "deviceId"   TEXT NOT NULL REFERENCES "DisplayDevice"("id") ON DELETE CASCADE,
  "secretHash" TEXT NOT NULL,
  "createdAt"  TEXT NOT NULL,
  "expiresAt"  TEXT NOT NULL,
  "revokedAt"  TEXT,
  "lastUsedAt" TEXT,
  "userAgent"  TEXT
);
CREATE INDEX "DeviceCredential_deviceId_idx" ON "DeviceCredential"("deviceId");

CREATE TABLE "PairingRequest" (
  "id"               TEXT PRIMARY KEY NOT NULL,
  "code"             TEXT NOT NULL UNIQUE,
  "pollSecretHash"   TEXT NOT NULL,
  "createdAt"        TEXT NOT NULL,
  "expiresAt"        TEXT NOT NULL,
  "approvedDeviceId" TEXT REFERENCES "DisplayDevice"("id") ON DELETE CASCADE,
  "approvedById"     TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "approvedAt"       TEXT,
  "consumedAt"       TEXT,
  "userAgent"        TEXT
);
CREATE INDEX "PairingRequest_expiresAt_idx" ON "PairingRequest"("expiresAt");

CREATE TABLE "DeviceCommand" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "deviceId"    TEXT NOT NULL REFERENCES "DisplayDevice"("id") ON DELETE CASCADE,
  "type"        TEXT NOT NULL,
  "payload"     TEXT,
  "status"      TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING', 'ACKED', 'FAILED', 'TIMEOUT')),
  "result"      TEXT,
  "error"       TEXT,
  "createdById" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "createdAt"   TEXT NOT NULL,
  "respondedAt" TEXT
);
CREATE INDEX "DeviceCommand_deviceId_createdAt_idx" ON "DeviceCommand"("deviceId", "createdAt");

CREATE TABLE "Schedule" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "name"        TEXT NOT NULL,
  "deviceId"    TEXT NOT NULL REFERENCES "DisplayDevice"("id") ON DELETE CASCADE,
  "playlistId"  TEXT NOT NULL REFERENCES "Playlist"("id") ON DELETE RESTRICT,
  "startDate"   TEXT,
  "endDate"     TEXT,
  "daysOfWeek"  TEXT NOT NULL DEFAULT '[]',
  "startTime"   TEXT NOT NULL,
  "endTime"     TEXT NOT NULL,
  "priority"    INTEGER NOT NULL DEFAULT 10,
  "enabled"     INTEGER NOT NULL DEFAULT 1,
  "createdById" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "createdAt"   TEXT NOT NULL,
  "updatedAt"   TEXT NOT NULL
);
CREATE INDEX "Schedule_deviceId_enabled_idx" ON "Schedule"("deviceId", "enabled");

CREATE TABLE "AuditLog" (
  "id"         TEXT PRIMARY KEY NOT NULL,
  "userId"     TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "deviceId"   TEXT REFERENCES "DisplayDevice"("id") ON DELETE SET NULL,
  "action"     TEXT NOT NULL,
  "entityType" TEXT,
  "entityId"   TEXT,
  "summary"    TEXT NOT NULL,
  "details"    TEXT,
  "ip"         TEXT,
  "createdAt"  TEXT NOT NULL
);
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");
CREATE INDEX "AuditLog_deviceId_createdAt_idx" ON "AuditLog"("deviceId", "createdAt");

CREATE TABLE "AppSetting" (
  "key"         TEXT PRIMARY KEY NOT NULL,
  "value"       TEXT NOT NULL,
  "updatedAt"   TEXT NOT NULL,
  "updatedById" TEXT
);

-- Limite de tentativas (login, vinculação, comandos). Substitui o @fastify/rate-limit em memória.
CREATE TABLE "RateLimit" (
  "key"     TEXT PRIMARY KEY NOT NULL,
  "count"   INTEGER NOT NULL,
  "resetAt" INTEGER NOT NULL
);
