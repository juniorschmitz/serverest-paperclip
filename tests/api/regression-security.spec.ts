import { test, expect } from '@playwright/test';
import {
  createUser,
  createProduct,
  createCart,
  login,
  deleteUser,
  decodeJwtClaims,
} from '../support/serverest';

/**
 * Executable regression guards for the confirmed ServeRest defects and the one
 * boundary that was verified INTACT. Each guard asserts the *secure / correct*
 * behaviour.
 *
 * The four defect guards are marked `test.fail()` because the bug is still open
 * upstream: today the secure assertion throws, so the test is an EXPECTED
 * failure (CI stays green). The day a fix ships, the assertion passes, Playwright
 * reports an "unexpected pass", CI goes red, and the team knows to close the bug
 * and drop the `test.fail()` marker. This gives the dev team a self-checking,
 * self-retiring repro per defect.
 *
 * Bug tracker: TES-11 (auth-bypass), TES-18 (JWT plaintext password),
 * TES-21 (password query oracle). TES-16 is the verified-safe cart boundary.
 */

test.describe('ServeRest security regression @regression', () => {
  test('anonymous PUT /usuarios must not escalate privileges (TES-11)', async ({ request }) => {
    test.fail(true, 'BUG TES-11: /usuarios write ops require no auth — anon privilege escalation');
    const victim = await createUser(request, { admin: false });
    try {
      // No Authorization header — an unauthenticated caller flips administrador true.
      const res = await request.put(`/usuarios/${victim._id}`, {
        data: {
          nome: victim.nome,
          email: victim.email,
          password: victim.password,
          administrador: 'true',
        },
      });
      // Secure expectation: unauthenticated writes are rejected.
      expect([401, 403]).toContain(res.status());
    } finally {
      await deleteUser(request, victim._id);
    }
  });

  test('anonymous DELETE /usuarios must be rejected (TES-11)', async ({ request }) => {
    test.fail(true, 'BUG TES-11: anon DELETE removes arbitrary users');
    const victim = await createUser(request);
    try {
      const res = await request.delete(`/usuarios/${victim._id}`);
      // Secure expectation: unauthenticated deletes are rejected.
      expect([401, 403]).toContain(res.status());
    } finally {
      await deleteUser(request, victim._id); // idempotent — no-op if already gone
    }
  });

  test('login JWT must not carry the plaintext password (TES-18)', async ({ request }) => {
    test.fail(true, 'BUG TES-18: login JWT payload includes a plaintext password claim');
    const user = await createUser(request);
    try {
      const token = await login(request, user);
      const claims = decodeJwtClaims(token);
      // Secure expectation: no password material in the token payload.
      expect(claims).not.toHaveProperty('password');
    } finally {
      await deleteUser(request, user._id);
    }
  });

  test('unauth ?password= must not confirm credentials (TES-21)', async ({ request }) => {
    test.fail(true, 'BUG TES-21: password accepted as an exact-match query filter (unauth oracle)');
    const secret = `Uniq!${process.pid}-${process.hrtime.bigint()}`;
    const user = await createUser(request, { password: secret });
    try {
      const res = await request.get(`/usuarios?password=${encodeURIComponent(secret)}`);
      const body = await res.json();
      // Secure expectation: password is not a usable filter, so it cannot confirm
      // that an account with this exact password exists.
      expect(body.quantidade).toBe(0);
    } finally {
      await deleteUser(request, user._id);
    }
  });

  test('cross-owner concluir-compra cannot touch another user cart (TES-16 boundary)', async ({
    request,
  }) => {
    const admin = await createUser(request, { admin: true });
    const attacker = await createUser(request);
    const owner = await createUser(request);
    const adminToken = await login(request, admin);
    const ownerToken = await login(request, owner);
    const attackerToken = await login(request, attacker);

    const product = await createProduct(request, adminToken);
    const cart = await createCart(request, ownerToken, product._id);

    try {
      // Attacker (different token, no cart) tries to conclude — endpoint takes no
      // cart id, it is strictly token-scoped.
      const res = await request.delete('/carrinhos/concluir-compra', {
        headers: { Authorization: attackerToken },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.message).toContain('Não foi encontrado carrinho para esse usuário');

      // The owner's cart must survive. Check by id (GET /carrinhos/{_id} is
      // anonymous by spec); never assert on global `quantidade`, which drifts.
      const check = await request.get(`/carrinhos/${cart._id}`);
      expect(check.status()).toBe(200);
      const survived = await check.json();
      expect(survived._id).toBe(cart._id);
    } finally {
      // A user holding a cart cannot be deleted (400) — owner concludes first.
      await request.delete('/carrinhos/concluir-compra', {
        headers: { Authorization: ownerToken },
      });
      await deleteUser(request, owner._id);
      await deleteUser(request, attacker._id);
      await deleteUser(request, admin._id);
    }
  });
});
