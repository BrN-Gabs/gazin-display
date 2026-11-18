/**
 * Primitivas de segurança com Web Crypto (disponível nativamente no Workers).
 *
 * Senhas: PBKDF2-SHA256 (PASSWORD_ITERATIONS: 50.000 no plano gratuito; até 100.000, o máximo do runtime),
 * formato `pbkdf2_sha256$<iterações>$<salt>$<hash>`.
 * Hashes Argon2id da versão 1 (Node) continuam aceitos: na primeira entrada com sucesso,
 * a senha é convertida automaticamente para PBKDF2 (veja `needsRehash`).
 */
import { argon2id } from '@noble/hashes/argon2.js';

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(s: string) {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomBytes(n: number) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomToken(bytes = 32) {
  return b64url(randomBytes(bytes));
}

export async function sha256(value: string | Uint8Array) {
  const data = typeof value === 'string' ? enc.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparação em tempo constante */
export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bytesEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256));
}

export async function hashPassword(password: string, iterations = 50_000) {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2_sha256$${iterations}$${b64url(salt)}$${b64url(hash)}`;
}

/** Argon2id legado ($argon2id$v=19$m=...,t=...,p=...$salt$hash) — usado apenas na primeira entrada após a migração */
function verifyArgon2(encoded: string, password: string) {
  const m = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(encoded);
  if (!m) return false;
  const salt = fromB64(m[5]!);
  const expected = fromB64(m[6]!);
  const out = argon2id(enc.encode(password), salt, { m: Number(m[2]), t: Number(m[3]), p: Number(m[4]), dkLen: expected.length, version: Number(m[1]) });
  return bytesEqual(out, expected);
}

export async function verifyPassword(hashValue: string, password: string) {
  try {
    if (hashValue.startsWith('pbkdf2_sha256$')) {
      const [, iter, salt, hash] = hashValue.split('$');
      const iterations = Number(iter);
      if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000 || !salt || !hash) return false;
      return bytesEqual(await pbkdf2(password, fromB64(salt), iterations), fromB64(hash));
    }
    if (hashValue.startsWith('$argon2id$')) return verifyArgon2(hashValue, password);
    return false;
  } catch {
    return false;
  }
}

/** Hash legado (Argon2) ou com menos iterações que o configurado: converter após login válido */
export function needsRehash(hashValue: string, iterations: number) {
  if (!hashValue.startsWith('pbkdf2_sha256$')) return true;
  return Number(hashValue.split('$')[1]) < iterations;
}

/** Hash fixo usado para equalizar o tempo de resposta quando o usuário não existe */
const DUMMY_SALT = 'Z2F6aW4tZGlzcGxheS1kdW1teQ';
export function dummyHash(iterations: number) {
  return `pbkdf2_sha256$${iterations}$${DUMMY_SALT}$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
}

const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I
export function pairingCode() {
  const bytes = randomBytes(6);
  let s = '';
  for (const b of bytes) s += PAIR_ALPHABET[b % PAIR_ALPHABET.length];
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

export function newIdentifier() {
  return `GD-${Array.from(randomBytes(6), (b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join('')}`;
}

export function normalizePairingCode(code: string) {
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

/** Política mínima de senha */
export function passwordProblems(pw: string): string | null {
  if (pw.length < 10) return 'A senha deve ter pelo menos 10 caracteres.';
  if (pw.length > 200) return 'A senha é muito longa.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) return 'Use ao menos 3 destes: minúsculas, maiúsculas, números e símbolos.';
  return null;
}
