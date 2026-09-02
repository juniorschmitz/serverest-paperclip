import { test, expect } from '@/fixtures';
import { expectContract, expectStatus } from '@/support/assertions';
import { credentialsOf } from '@/data/factories';
import type { LoginBody } from '@/api/types';

/**
 * Automation order #1 (login half) and #6 (fast half of the token matrix).
 *
 * F12 — login happy path + negative cases. F4 — token negative matrix: every
 * malformed-credential shape that must fail cleanly with 401/403, never a 500.
 * The one F4 case NOT here is the genuinely-elapsed 600s token: that needs a
 * real 10-minute wait and lives in token-expiry.api.spec.ts so its reliability
 * run does not tax every other run in this file.
 */
test.describe('F12 login contract', () => {
  test('a registered user can log in and receives a bearer JWT', async ({ newActor, anonApi }) => {
    const actor = await newActor();

    const res = await anonApi.post<LoginBody>('/login', { body: credentialsOf(actor.user.payload) });
    expectStatus(res, 200);
    expectContract(res);
    expect(res.body.authorization, 'expected "Bearer <jwt>"').toMatch(/^Bearer\s+\S+\.\S+\.\S+$/);
  });

  test('the wrong password is rejected with 401, not a generic 400', async ({
    newActor,
    anonApi,
  }) => {
    const actor = await newActor();

    const res = await anonApi.post('/login', {
      body: { email: actor.user.payload.email, password: 'not-the-password' },
    });
    expectStatus(res, 401);
    expectContract(res);
  });

  test('a login for an email that was never registered is rejected with 401', async ({
    anonApi,
  }) => {
    const res = await anonApi.post('/login', {
      body: { email: 'nobody-here@qa.testcia.dev', password: 'whatever123' },
    });
    expectStatus(res, 401);
  });

  test('missing credentials are rejected with 400 and field-level messages', async ({
    anonApi,
  }) => {
    const res = await anonApi.post<Record<string, string>>('/login', { body: {} });
    expectStatus(res, 400);
    expect(res.body['email']).toBeTruthy();
    expect(res.body['password']).toBeTruthy();
  });
});

test.describe('F4 token negative matrix', () => {
  // All driven against POST /produtos because it is admin-only: it fails
  // clearly on any credential defect, not just a missing one, and it is a
  // write, so a passing test proves the check ran before the write.
  const seedProduct = () => ({ nome: `token-matrix-probe-${Date.now()}`, preco: 1, descricao: 'x', quantidade: 1 });

  test('an absent Authorization header is rejected with 401', async ({ anonApi }) => {
    const res = await anonApi.post('/produtos', { body: seedProduct() });
    expectStatus(res, 401);
  });

  test('a malformed JWT is rejected with 401, not a 500', async ({ anonApi }) => {
    const res = await anonApi.post('/produtos', {
      body: seedProduct(),
      rawAuthorization: 'Bearer this.is.not.a.jwt',
    });
    expectStatus(res, 401);
  });

  test('a truncated JWT is rejected with 401', async ({ admin, anonApi }) => {
    // Truncate a real token so the header shape is right but the signature is not.
    const real = await admin.api.tokenManager.authHeader(admin.user.credentials);
    const truncated = real.slice(0, Math.floor(real.length * 0.6));

    const res = await anonApi.post('/produtos', { body: seedProduct(), rawAuthorization: truncated });
    expectStatus(res, 401);
  });

  test('a bearer token sent without the "Bearer " prefix is rejected with 401', async ({
    admin,
    anonApi,
  }) => {
    const real = await admin.api.tokenManager.authHeader(admin.user.credentials);
    const raw = real.replace(/^Bearer\s+/i, '');

    const res = await anonApi.post('/produtos', { body: seedProduct(), rawAuthorization: raw });
    expectStatus(res, 401);
  });

  test('an empty Authorization value is rejected with 401', async ({ anonApi }) => {
    const res = await anonApi.post('/produtos', { body: seedProduct(), rawAuthorization: '' });
    expectStatus(res, 401);
  });

  test('a valid non-admin token on an admin-only route is rejected with 403, not 401', async ({
    newActor,
  }) => {
    const nonAdmin = await newActor({ administrador: 'false' });
    const res = await nonAdmin.produtos.create(seedProduct());
    expectStatus(res, 403);
  });
});
