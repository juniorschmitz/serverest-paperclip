import { test, expect } from '@/fixtures';
import { expectStatus } from '@/support/assertions';

/**
 * Automation order #8 — F3: the two delete guards that prevent orphaned
 * records. Both leave the offending resource in place, so each test cleans up
 * through the normal cart cancel before its seeded product/user teardown runs.
 */
test.describe('F3 referential integrity delete guards', () => {
  test('a product inside a live cart cannot be deleted', async ({ admin }) => {
    const product = await admin.produtos.seed({ quantidade: 5 });
    const cart = await admin.carrinhos.seed([{ idProduto: product.id, quantidade: 1 }]);

    const res = await admin.produtos.remove(product.id);
    expectStatus(res, 400);
    expect(
      (res.body as { message: string; idCarrinhos: string[] }).idCarrinhos,
      'the error should name the blocking cart',
    ).toContain(cart.id);

    // Clear the cart ourselves so teardown's product delete does not repeat
    // this same 400 and get reported as a cleanup failure.
    await admin.carrinhos.cancelarCompra();
  });

  test('a user who owns a live cart cannot be deleted', async ({ newActor }) => {
    const buyer = await newActor();
    const product = await newActor({ administrador: 'true' }).then((a) => a.produtos.seed({ quantidade: 5 }));
    const cart = await buyer.carrinhos.seed([{ idProduto: product.id, quantidade: 1 }]);

    const res = await buyer.usuarios.remove(buyer.user.id);
    expectStatus(res, 400);
    expect(
      (res.body as { message: string; idCarrinho: string }).idCarrinho,
      'the error should name the blocking cart',
    ).toBe(cart.id);

    await buyer.carrinhos.cancelarCompra();
  });
});
