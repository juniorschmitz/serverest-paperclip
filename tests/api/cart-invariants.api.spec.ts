import { test, expect } from '@/fixtures';
import { expectStatus } from '@/support/assertions';

/**
 * Automation order #3 — F2: the cart negative invariants. Same subsystem as
 * cart-lifecycle.api.spec.ts, built while those fixtures are already warm.
 * Every case here is a raw `create()` call, never `seed()` — these are
 * deliberately the requests that must NOT succeed, so nothing here should
 * assert 201 first.
 */
test.describe('F2 cart negative invariants', () => {
  test('a user cannot own two carts at once', async ({ admin }) => {
    const product = await admin.produtos.seed({ quantidade: 10 });
    await admin.carrinhos.seed([{ idProduto: product.id, quantidade: 1 }]);

    const second = await admin.carrinhos.create({ produtos: [{ idProduto: product.id, quantidade: 1 }] });
    expectStatus(second, 400);
    expect(second.body.message).toMatch(/não é permitido ter mais de 1 carrinho/i);
  });

  test('ordering more than the available stock is rejected', async ({ admin }) => {
    const product = await admin.produtos.seed({ quantidade: 5 });

    const res = await admin.carrinhos.create({
      produtos: [{ idProduto: product.id, quantidade: 999 }],
    });
    expectStatus(res, 400);
    expect(res.body.message).toMatch(/quantidade suficiente/i);
  });

  test('the same product listed twice in one request is rejected as a duplicate', async ({
    admin,
  }) => {
    const product = await admin.produtos.seed({ quantidade: 10 });

    const res = await admin.carrinhos.create({
      produtos: [
        { idProduto: product.id, quantidade: 1 },
        { idProduto: product.id, quantidade: 1 },
      ],
    });
    expectStatus(res, 400);
    expect(res.body.message).toMatch(/produto duplicado/i);
  });

  test('zero and negative quantities are both rejected', async ({ admin }) => {
    const product = await admin.produtos.seed({ quantidade: 10 });

    for (const quantidade of [0, -1]) {
      const res = await admin.carrinhos.create({ produtos: [{ idProduto: product.id, quantidade }] });
      expectStatus(res, 400);
    }
  });

  test('a non-existent product id is rejected rather than silently accepted', async ({ admin }) => {
    const res = await admin.carrinhos.create({
      produtos: [{ idProduto: 'this-product-does-not-exist', quantidade: 1 }],
    });
    expectStatus(res, 400);
    expect(res.body.message).toMatch(/produto não encontrado/i);
  });
});
