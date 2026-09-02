import { APIRequestContext, expect } from '@playwright/test';

/**
 * Helpers for self-seeding identities on the shared ServeRest sandbox.
 * ServeRest rejects *.test TLDs on POST /usuarios — use @qa.com.
 * Login tokens expire in 600s, so fetch a token per test, not once globally.
 */

export interface SeededUser {
  _id: string;
  nome: string;
  email: string;
  password: string;
  administrador: 'true' | 'false';
}

function uniqueSuffix(): string {
  // Unique-per-worker identity without Date.now()/random collisions in parallel.
  const w = process.env.TEST_WORKER_INDEX ?? '0';
  const seq = (globalThis as any).__serverestSeq = ((globalThis as any).__serverestSeq ?? 0) + 1;
  return `${process.pid}-${w}-${seq}`;
}

export async function createUser(
  api: APIRequestContext,
  opts: { admin?: boolean; password?: string } = {}
): Promise<SeededUser> {
  const suffix = uniqueSuffix();
  const body = {
    nome: `QA User ${suffix}`,
    email: `qa.${suffix}@qa.com`,
    password: opts.password ?? 'Str0ngPass!',
    administrador: opts.admin ? 'true' : 'false',
  };
  const res = await api.post('/usuarios', { data: body });
  expect(res.status(), await res.text()).toBe(201);
  const json = await res.json();
  return { _id: json._id, ...body } as SeededUser;
}

/** Admin-authenticated product creation. Unique nome per call (ServeRest 409s on dupes). */
export async function createProduct(
  api: APIRequestContext,
  token: string,
  opts: { preco?: number; quantidade?: number } = {}
): Promise<{ _id: string; nome: string }> {
  const suffix = uniqueSuffix();
  const body = {
    nome: `QA Product ${suffix}`,
    preco: opts.preco ?? 100,
    descricao: 'regression fixture',
    quantidade: opts.quantidade ?? 50,
  };
  const res = await api.post('/produtos', { data: body, headers: { Authorization: token } });
  expect(res.status(), await res.text()).toBe(201);
  const json = await res.json();
  return { _id: json._id, nome: body.nome };
}

/** Create a cart for the token's user containing one product. One cart per user. */
export async function createCart(
  api: APIRequestContext,
  token: string,
  idProduto: string,
  quantidade = 1
): Promise<{ _id: string }> {
  const res = await api.post('/carrinhos', {
    data: { produtos: [{ idProduto, quantidade }] },
    headers: { Authorization: token },
  });
  expect(res.status(), await res.text()).toBe(201);
  const json = await res.json();
  return { _id: json._id };
}

/** Decode a `Bearer <jwt>` token's payload claims without verifying the signature. */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const jwt = token.replace(/^Bearer\s+/i, '');
  const payload = jwt.split('.')[1];
  const json = Buffer.from(payload, 'base64url').toString('utf8');
  return JSON.parse(json);
}

export async function login(
  api: APIRequestContext,
  user: { email: string; password: string }
): Promise<string> {
  const res = await api.post('/login', {
    data: { email: user.email, password: user.password },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = await res.json();
  expect(json.authorization).toContain('Bearer ');
  return json.authorization as string;
}

export async function deleteUser(api: APIRequestContext, id: string): Promise<void> {
  await api.delete(`/usuarios/${id}`);
}
