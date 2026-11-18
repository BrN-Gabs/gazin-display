import type { C } from '../auth';
import { badRequest } from '../lib/errors';

/** Corpo JSON da requisição (vazio = {}). JSON inválido → 400, como na versão 1. */
export async function readBody(c: C): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Formato de requisição inválido.');
  }
}

/** Query string como objeto simples (para validação com zod) */
export const queryObject = (c: C) => Object.fromEntries(new URL(c.req.url).searchParams.entries());
