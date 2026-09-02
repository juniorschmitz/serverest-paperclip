import { test, expect } from '@/fixtures';
import { expectStatus } from '@/support/assertions';
import { buildUser } from '@/data/factories';
import type { UsuarioListBody } from '@/api/types';

/**
 * Automation order #4 — characterisation pins for every open defect the
 * coverage map (strategy.md §5, Appendix A) names. Two confirmed findings are
 * spec-declared: swagger.json itself grants no `security` on these
 * operations, so the implementation matches its own spec. Asserting the
 * *desired* behaviour would leave the pipeline red from day one; asserting
 * *current* behaviour keeps it green and truthful.
 *
 * Every test here is tagged @known-defect and named so a GREEN result reads
 * as bad news. `npm run test -- --grep-invert @known-defect` gives the "should
 * this product pass" view. When a defect closes, flip the assertion here in
 * the same commit that removes the tag — never delete the test, or the
 * regression guard disappears with the fix.
 */
test.describe('@known-defect characterisation pins', () => {
  test('UNFIXED (TES-11): anonymous PUT /usuarios/{id} still edits and privilege-escalates with no token', async ({
    newActor,
    anonApi,
  }) => {
    const victim = await newActor({ administrador: 'false' });

    const res = await anonApi.put(`/usuarios/{_id}`, {
      pathParams: { _id: victim.user.id },
      body: { ...victim.user.payload, nome: 'Hacked by anonymous PUT', administrador: 'true' },
    });

    // Flip to 401 when TES-11 closes.
    expectStatus(res, 200);

    const check = await anonApi.get('/usuarios/{_id}', { pathParams: { _id: victim.user.id } });
    expectStatus(check, 200);
    expect(
      (check.body as { administrador: string }).administrador,
      'anonymous PUT should not be able to grant admin — flip this to "false" once TES-11 closes',
    ).toBe('true');
  });

  test('UNFIXED (TES-11): anonymous DELETE /usuarios/{id} still deletes with no token', async ({
    usuarios,
    anonApi,
    registry,
  }) => {
    // Created via the raw client, not seed(): the delete under test IS the
    // teardown this victim would otherwise get, so cleanup here only needs to
    // cover the case where the defect is already fixed and the delete failed.
    const payload = buildUser({ administrador: 'false' });
    const created = await usuarios.create(payload);
    expectStatus(created, 201);
    const victimId = created.body._id;
    registry.track('usuario', `${victimId} (${payload.email})`, async () => {
      const del = await anonApi.delete<{ message: string }>('/usuarios/{_id}', {
        pathParams: { _id: victimId },
      });
      const alreadyGone = del.status === 400 && /não encontrado/i.test(del.body.message ?? '');
      if (del.status >= 400 && !alreadyGone) {
        throw new Error(`DELETE /usuarios/${victimId} -> ${del.status} ${JSON.stringify(del.body)}`);
      }
    });

    const res = await anonApi.delete<{ message: string }>('/usuarios/{_id}', {
      pathParams: { _id: victimId },
    });

    // Flip to 401 when TES-11 closes.
    expectStatus(res, 200);

    const check = await anonApi.get('/usuarios/{_id}', { pathParams: { _id: victimId } });
    expect(check.status, 'the account should be gone after an anonymous delete').toBe(400);
  });

  test('UNFIXED (TES-14): GET /usuarios exposes plaintext passwords to anonymous callers', async ({
    newActor,
    anonApi,
  }) => {
    const actor = await newActor();

    const res = await anonApi.get<UsuarioListBody>('/usuarios', { query: { email: actor.user.payload.email } });
    expectStatus(res, 200);

    const found = res.body.usuarios.find((u) => u.email === actor.user.payload.email);
    // Flip to `toBeUndefined()` / assert the field is absent once TES-14 closes.
    expect(
      found?.password,
      'the plaintext password should not be readable by an anonymous caller',
    ).toBe(actor.user.payload.password);
  });

  test('UNFIXED (TES-13): concluir-compra on a user with no cart returns 200, not 404', async ({
    newActor,
  }) => {
    const actor = await newActor();

    const res = await actor.carrinhos.concluirCompra();
    // Flip to 404 when TES-13 closes. Status alone would pass on the success
    // path too — that is exactly the trap this pin exists to name (strategy §5).
    expectStatus(res, 200);
    expect(res.body.message).toMatch(/não foi encontrado carrinho/i);
  });

  test('UNFIXED (TES-13): cancelar-compra on a user with no cart returns 200, not 404', async ({
    newActor,
  }) => {
    const actor = await newActor();

    const res = await actor.carrinhos.cancelarCompra();
    // Flip to 404 when TES-13 closes.
    expectStatus(res, 200);
    expect(res.body.message).toMatch(/não foi encontrado carrinho/i);
  });

  test('UNFIXED (TES-20): a malformed NoSQL operator on idUsuario still leaks an unauthenticated 500 with a stack trace', async ({
    anonApi,
  }) => {
    // $eq is not implemented by the embedded nedb store; the query reaches the
    // engine unvalidated and the failure leaks internals. Appendix A of the
    // strategy document has the full grid.
    const res = await anonApi.get<{ error?: { stack?: string }; version?: string }>('/carrinhos', {
      query: { 'idUsuario[$eq]': 'x' },
      skipContract: true,
    });

    // Flip to 400, and drop the stack-trace assertion, when TES-20 closes.
    expectStatus(res, 500);
    expect(
      res.body.error?.stack,
      'an unauthenticated caller should never receive an internal stack trace',
    ).toContain('nedb');
  });

  test('UNFIXED (TES-21): password is still accepted as an exact-match query filter on /usuarios', async ({
    newActor,
    anonApi,
  }) => {
    const actor = await newActor();

    const res = await anonApi.get<UsuarioListBody>('/usuarios', {
      query: { password: actor.user.payload.password },
    });
    expectStatus(res, 200);

    // Flip to "not contain our user" (or a 400/ignored-field response) when
    // TES-21 closes — this is a credential-confirmation oracle, not cosmetic.
    const found = res.body.usuarios.find((u) => u.email === actor.user.payload.email);
    expect(
      found,
      'an anonymous caller should not be able to confirm a password by filtering on it',
    ).toBeDefined();
  });

  test('UNFIXED (TES-18): the login JWT still carries the account password as a claim', async ({
    newActor,
  }) => {
    // Ported from the pre-convention tests/api/regression-security.spec.ts
    // (retired alongside tests/api/smoke.spec.ts and tests/support/serverest.ts
    // — see TES-23) so this defect keeps a live guard under the characterisation
    // convention instead of losing coverage when that file was deleted.
    const actor = await newActor();

    const header = await actor.api.tokenManager.authHeader(actor.user.credentials);
    const claims = decodeJwtClaims(header);

    // Flip to `expect(claims).not.toHaveProperty('password')` when TES-18 closes.
    expect(
      claims['password'],
      'the JWT payload should not carry the account password',
    ).toBe(actor.user.payload.password);
  });
});

/** Decode a `Bearer <jwt>` token's payload claims without verifying the signature. */
function decodeJwtClaims(header: string): Record<string, unknown> {
  const jwt = header.replace(/^Bearer\s+/i, '');
  const payload = jwt.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}
