/**
 * Upload direto do navegador ao R2 (API S3) com URLs pré-assinadas de curta duração.
 *
 * O Worker cria e conclui o upload multipart pelo binding do R2; o navegador envia cada parte
 * diretamente ao R2 com uma URL assinada (válida por poucos minutos e restrita a uma única parte),
 * então o arquivo nunca atravessa o Worker e não há credenciais no frontend.
 * As chaves de API do R2 ficam somente nos secrets do Worker (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY).
 */
import { AwsClient } from 'aws4fetch';
import type { AppConfig, Env } from '../env';

export const PRESIGN_TTL_SEC = 15 * 60;

function client(env: Env) {
  return new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY!, service: 's3', region: 'auto' });
}

function objectUrl(config: AppConfig, key: string) {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return new URL(`${config.r2.endpoint.replace(/\/$/, '')}/${encodeURIComponent(config.r2.bucket)}/${path}`);
}

export async function presignUploadPart(env: Env, config: AppConfig, key: string, uploadId: string, partNumber: number, ttlSec = PRESIGN_TTL_SEC) {
  const url = objectUrl(config, key);
  url.searchParams.set('partNumber', String(partNumber));
  url.searchParams.set('uploadId', uploadId);
  url.searchParams.set('X-Amz-Expires', String(ttlSec));
  const signed = await client(env).sign(new Request(url, { method: 'PUT' }), { aws: { signQuery: true } });
  return { url: signed.url, expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString() };
}

/** Alternativa pela API S3, usada se o binding recusar as ETags devolvidas ao navegador */
export async function s3CompleteMultipart(env: Env, config: AppConfig, key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>) {
  const url = objectUrl(config, key);
  url.searchParams.set('uploadId', uploadId);
  const xml = `<CompleteMultipartUpload>${parts
    .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag.replace(/"/g, '')}"</ETag></Part>`)
    .join('')}</CompleteMultipartUpload>`;
  const res = await client(env).fetch(url.toString(), { method: 'POST', body: xml, headers: { 'Content-Type': 'application/xml' } });
  const text = await res.text();
  if (!res.ok || text.includes('<Error>')) throw new Error(`R2 CompleteMultipartUpload falhou (${res.status}): ${text.slice(0, 300)}`);
}

export const normalizeEtag = (etag: string) => etag.trim().replace(/^W\//, '').replace(/"/g, '');
