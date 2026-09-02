import { test, expect } from '@/fixtures';
import { expectContract, expectStatus } from '@/support/assertions';
import type { Produto } from '@/api/types';

/**
 * Automation order #2 — F1 / J1 / J2: the cart state machine and stock
 * accounting. The only genuinely stateful multi-step business logic in the
 * product, and per §5 of the strategy the one hard rule every assertion here
 * follows: never assert a bare `200` on cart finalisation. `concluir-compra`
 * and `cancelar-compra` both return 200 on the no-cart error path (TES-13),
 * so status alone proves nothing — message and stock are asserted alongside it
 * every time.
 *
 * Stock is read straight from GET /produtos/{_id}.quantidade before and after
 * each step. That field is per-product, not a global list count, so it is
 * safe on a shared sandbox: nobody else can move stock on a product only this
 * test created.
 */
test.describe('F1 cart lifecycle & stock invariants', () => {
  async function stockOf(admin: { produtos: { getById(id: string): Promise<{ body: unknown }> } }, id: string) {
    const res = await admin.produtos.getById(id);
    return (res.body as Produto).quantidade;
  }

  test('J1: creating a cart decrements stock, and concluding it consumes the stock permanently', async ({
    admin,
  }) => {
    const product = await admin.produtos.seed({ quantidade: 10 });
    expect(await stockOf(admin, product.id)).toBe(10);

    const cart = await admin.carrinhos.seed([{ idProduto: product.id, quantidade: 3 }]);
    expect(
      await stockOf(admin, product.id),
      'creating a cart should decrement stock by the quantity added',
    ).toBe(7);

    const concluded = await admin.carrinhos.concluirCompra();
    expectStatus(concluded, 200);
    expectContract(concluded);
    expect(concluded.body.message).not.toMatch(/não foi encontrado carrinho/i);

    expect(
      await stockOf(admin, product.id),
      'concluding a purchase must not return the stock it consumed',
    ).toBe(7);

    const goneCart = await admin.carrinhos.getById(cart.id);
    expect(goneCart.status, 'the cart should not be retrievable after checkout').toBe(400);
  });

  test('J2: creating a cart decrements stock, and cancelling it restores the stock', async ({
    newActor,
  }) => {
    const buyer = await newActor();
    const admin = await newActor({ administrador: 'true' });
    const product = await admin.produtos.seed({ quantidade: 10 });
    expect(await stockOf(admin, product.id)).toBe(10);

    // seed() would register its own cancel in teardown; call create() directly
    // so this test owns the one cancel call it is asserting on.
    const created = await buyer.carrinhos.create({ produtos: [{ idProduto: product.id, quantidade: 4 }] });
    expectStatus(created, 201);
    expect(
      await stockOf(admin, product.id),
      'creating a cart should decrement stock by the quantity added',
    ).toBe(6);

    const cancelled = await buyer.carrinhos.cancelarCompra();
    expectStatus(cancelled, 200);
    expectContract(cancelled);
    expect(cancelled.body.message).not.toMatch(/não foi encontrado carrinho/i);

    expect(
      await stockOf(admin, product.id),
      'cancelling a purchase must restore the stock it had reserved',
    ).toBe(10);

    const goneCart = await buyer.carrinhos.getById(created.body._id);
    expect(goneCart.status, 'the cart should not be retrievable after cancellation').toBe(400);
  });

  test('a cart spanning two products decrements stock on both independently', async ({ admin }) => {
    const productA = await admin.produtos.seed({ quantidade: 5 });
    const productB = await admin.produtos.seed({ quantidade: 5 });

    await admin.carrinhos.seed([
      { idProduto: productA.id, quantidade: 2 },
      { idProduto: productB.id, quantidade: 1 },
    ]);

    expect(await stockOf(admin, productA.id)).toBe(3);
    expect(await stockOf(admin, productB.id)).toBe(4);

    await admin.carrinhos.cancelarCompra();
    expect(await stockOf(admin, productA.id)).toBe(5);
    expect(await stockOf(admin, productB.id)).toBe(5);
  });
});
