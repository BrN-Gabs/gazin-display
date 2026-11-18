import { describe, expect, it } from 'vitest';
import { dummyHash, hashPassword, needsRehash, normalizePairingCode, passwordProblems, verifyPassword } from '../../src/worker/lib/security';
import { presignUploadPart, normalizeEtag } from '../../src/worker/lib/r2';
import { loadConfig, type Env } from '../../src/worker/env';
import { parseRange } from '../../src/worker/lib/http';

describe('senhas (PBKDF2 no Workers)', () => {
  it('gera e verifica hash; recusa senha errada e hash malformado', async () => {
    const h = await hashPassword('Senha-Forte-123', 1000);
    expect(h).toMatch(/^pbkdf2_sha256\$1000\$/);
    expect(await verifyPassword(h, 'Senha-Forte-123')).toBe(true);
    expect(await verifyPassword(h, 'Senha-Forte-124')).toBe(false);
    expect(await verifyPassword('lixo', 'x')).toBe(false);
    expect(await verifyPassword(dummyHash(1000), 'qualquer')).toBe(false);
    expect(needsRehash(h, 100_000)).toBe(true);
    expect(needsRehash('$argon2id$v=19$...', 1000)).toBe(true);
  });

  it('política de senha e código de vinculação', () => {
    expect(passwordProblems('curta')).toMatch(/10 caracteres/);
    expect(passwordProblems('somenteminusculas')).toMatch(/3 destes/);
    expect(passwordProblems('Senha-Forte-123')).toBeNull();
    expect(normalizePairingCode('k7m4qx')).toBe('K7M-4QX');
  });
});

describe('URLs pré-assinadas do R2', () => {
  const env = { R2_ACCOUNT_ID: 'abc123', R2_ACCESS_KEY_ID: 'AKIATESTE', R2_SECRET_ACCESS_KEY: 'segredo', R2_BUCKET_NAME: 'gazin-display-media' } as unknown as Env;

  it('assina somente a parte indicada, com validade curta e sem expor o segredo', async () => {
    const config = loadConfig(env);
    expect(config.directUpload).toBe(true);
    const { url, expiresAt } = await presignUploadPart(env, config, 'media/x/playback.mp4', 'UPLOAD-ID', 3);
    const u = new URL(url);
    expect(u.host).toBe('abc123.r2.cloudflarestorage.com');
    expect(u.pathname).toBe('/gazin-display-media/media/x/playback.mp4');
    expect(u.searchParams.get('partNumber')).toBe('3');
    expect(u.searchParams.get('uploadId')).toBe('UPLOAD-ID');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get('X-Amz-Credential')).toContain('AKIATESTE');
    expect(url).not.toContain('segredo');
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(900_000);
  });

  it('sem credenciais, o upload passa pelo Worker (modo proxy)', () => {
    expect(loadConfig({} as Env).directUpload).toBe(false);
    expect(loadConfig({ UPLOAD_CHUNK_MB: '1' } as Env).chunkBytes).toBe(5 * 1024 * 1024); // mínimo do R2
  });

  it('normaliza ETag e interpreta Range', () => {
    expect(normalizeEtag('"abc"')).toBe('abc');
    expect(normalizeEtag('W/"abc"')).toBe('abc');
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=2000-', 1000)).toBe('invalid');
    expect(parseRange(null, 1000)).toBeNull();
  });
});
