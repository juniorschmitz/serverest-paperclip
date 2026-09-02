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
  opts: { admin?: boolean } = {}
): Promise<SeededUser> {
  const suffix = uniqueSuffix();
  const body = {
    nome: `QA User ${suffix}`,
    email: `qa.${suffix}@qa.com`,
    password: 'Str0ngPass!',
    administrador: opts.admin ? 'true' : 'false',
  };
  const res = await api.post('/usuarios', { data: body });
  expect(res.status(), await res.text()).toBe(201);
  const json = await res.json();
  return { _id: json._id, ...body } as SeededUser;
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
