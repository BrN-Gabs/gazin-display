import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/** Argon2id (parâmetros OWASP: m=19 MiB, t=2, p=1) */
const ARGON_OPTS = { algorithm: 2 /* Argon2id */, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string) {
  return hash(password, ARGON_OPTS);
}

export async function verifyPassword(hashValue: string, password: string) {
  try {
    return await verify(hashValue, password);
  } catch {
    return false;
  }
}

/** Hash fixo usado para equalizar o tempo de resposta quando o usuário não existe */
let dummyHash: Promise<string> | null = null;
export function getDummyHash() {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I
export function pairingCode() {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (const b of bytes) s += PAIR_ALPHABET[b % PAIR_ALPHABET.length];
  return `${s.slice(0, 3)}-${s.slice(3)}`;
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
