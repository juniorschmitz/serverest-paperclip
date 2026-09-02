import { test, expect } from '@/fixtures';
import { expectContract, expectStatus } from '@/support/assertions';
import { buildProduct } from '@/data/factories';

/**
 * Automation order #5 — F11 / J3: the one privilege boundary that currently
 * works end to end. Currently correct and high-impact if it regresses —
 * exactly the shape of test worth having even though it is not expected to
 * ever go red.
 */
test.describe('F11 /produtos admin boundary', () => {
  test('anonymous product creation is rejected with 401', async ({ anonApi }) => {
    const res = await anonApi.post('/produtos', { body: buildProduct() });
    expectStatus(res, 401);
  });

  test('a non-admin cannot create a product (403)', async ({ newActor }) => {
    const nonAdmin = await newActor({ administrador: 'false' });
    const res = await nonAdmin.produtos.create(buildProduct());
    expectStatus(res, 403);
  });

  test('J3: an admin can create a product (201) and it is retrievable', async ({ admin }) => {
    const product = await admin.produtos.seed();

    const res = await admin.produtos.getById(product.id);
    expectStatus(res, 200);
    expectContract(res);
  });
});
