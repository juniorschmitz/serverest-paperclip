import { test, expect } from '@/fixtures';
import { expectContract, expectStatus } from '@/support/assertions';
import { buildUser } from '@/data/factories';

/**
 * Automation order #7 — F7 / F12: registration, and the one positive control
 * on the board. Unknown fields are rejected today on POST /usuarios, which is
 * what blocks smuggling `role` / a second `administrador` key past validation
 * into a privilege escalation. If this ever starts returning 201, that is a
 * new escalation path opening up, not a validation nicety regressing.
 */
test.describe('F7/F12 registration', () => {
  test('a valid registration succeeds and the account is retrievable', async ({
    usuarios,
    registry,
  }) => {
    const payload = buildUser();
    const res = await usuarios.create(payload);
    expectStatus(res, 201);
    expectContract(res);
    expect(res.body._id).toBeTruthy();

    registry.track('usuario', `${res.body._id} (${payload.email})`, async () => {
      const del = await usuarios.remove(res.body._id);
      if (del.status >= 400) throw new Error(`DELETE /usuarios/${res.body._id} -> ${del.status}`);
    });

    const fetched = await usuarios.getById(res.body._id);
    expectStatus(fetched, 200);
    expect(fetched.body).toMatchObject({ nome: payload.nome, email: payload.email });
  });

  test('registering with an email already in use is rejected with 400', async ({
    newActor,
    usuarios,
  }) => {
    const existing = await newActor();

    const res = await usuarios.create({ ...existing.user.payload, nome: 'Someone else entirely' });
    expectStatus(res, 400);
    expect(res.body.message).toMatch(/email já está sendo usado/i);
  });

  test('a positive control: an unknown field cannot be used to smuggle extra privileges', async ({
    usuarios,
  }) => {
    const payload = { ...buildUser(), role: 'admin' };
    const res = await usuarios.create(payload);

    expectStatus(res, 400);
    expect(
      (res.body as unknown as { role: string }).role,
      'unknown fields must be rejected, not silently dropped or honoured',
    ).toMatch(/não é permitido/i);
  });
});
