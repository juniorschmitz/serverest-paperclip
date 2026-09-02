import { test, expect } from '@playwright/test';
import { createUser, login, deleteUser } from '../support/serverest';

/**
 * Smoke coverage of the critical ServeRest path: reachability, self-serve
 * account creation, authentication, and an authenticated read. This is the
 * foundation the full functional suite (Login/Usuarios/Produtos/Carrinhos)
 * builds on. Every identity is unique-per-worker and cleaned up.
 */

test.describe('ServeRest @smoke', () => {
  test('API is reachable (Swagger served at root)', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
  });

  test('self-serve account creation returns 201 + id', async ({ request }) => {
    const user = await createUser(request);
    expect(user._id).toBeTruthy();
    await deleteUser(request, user._id);
  });

  test('login issues a Bearer token', async ({ request }) => {
    const user = await createUser(request);
    const token = await login(request, user);
    expect(token).toMatch(/^Bearer /);
    await deleteUser(request, user._id);
  });

  test('authenticated GET /usuarios succeeds', async ({ request }) => {
    const admin = await createUser(request, { admin: true });
    const token = await login(request, admin);
    const res = await request.get('/usuarios', {
      headers: { Authorization: token },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.usuarios)).toBe(true);
    await deleteUser(request, admin._id);
  });

  test('login with wrong password is rejected (401)', async ({ request }) => {
    const user = await createUser(request);
    const res = await request.post('/login', {
      data: { email: user.email, password: 'wrong-password' },
    });
    expect(res.status()).toBe(401);
    await deleteUser(request, user._id);
  });
});
