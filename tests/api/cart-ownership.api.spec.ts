import { test, expect } from '@/fixtures';
import { expectStatus } from '@/support/assertions';
import type { Produto } from '@/api/types';

/**
 * Automation order #9 — F5: wrong-owner cart operations (IDOR). This is a
 * clean regression guard, not exploratory anymore — TES-16 drove all five
 * missions live first, specifically so this suite would not harden a test
 * around an unverified assumption about the cart boundary. Result: the
 * boundary holds. `concluir-compra` and `cancelar-compra` carry no cart id and
 * resolve strictly from the caller's own token, so there is no id to steal.
 *
 * `GET /carrinhos/{_id}` is deliberately not asserted here as an IDOR case: it
 * is public by design (swagger declares no security on it, same class as the
 * already-pinned TES-14 exposure), so a caller reading another user's cart is
 * not a privilege boundary being crossed.
 */
test.describe('F5 wrong-owner cart operations', () => {
  async function stockOf(admin: { produtos: { getById(id: string): Promise<{ body: unknown }> } }, id: string) {
    const res = await admin.produtos.getById(id);
    return (res.body as Produto).quantidade;
  }

  test("concluding as the wrong owner does not touch another user's cart or stock", async ({
    admin,
    newActor,
  }) => {
    const owner = await newActor();
    const intruder = await newActor();
    const product = await admin.produtos.seed({ quantidade: 10 });
    const cart = await owner.carrinhos.seed([{ idProduto: product.id, quantidade: 3 }]);

    const res = await intruder.carrinhos.concluirCompra();
    expectStatus(res, 200);
    expect(
      res.body.message,
      'the intruder has no cart of their own, so this must be the no-cart message, never a success',
    ).toMatch(/não foi encontrado carrinho/i);

    const stillThere = await owner.carrinhos.getById(cart.id);
    expectStatus(stillThere, 200);
    expect(await stockOf(admin, product.id), "the owner's stock reservation must be untouched").toBe(7);
  });

  test("cancelling as the wrong owner does not restore another user's stock", async ({
    admin,
    newActor,
  }) => {
    const owner = await newActor();
    const intruder = await newActor();
    const product = await admin.produtos.seed({ quantidade: 10 });
    await owner.carrinhos.seed([{ idProduto: product.id, quantidade: 4 }]);

    const res = await intruder.carrinhos.cancelarCompra();
    expectStatus(res, 200);
    expect(res.body.message).toMatch(/não foi encontrado carrinho/i);

    expect(
      await stockOf(admin, product.id),
      "an intruder's no-op cancel must not restore stock that was never theirs",
    ).toBe(6);
  });

  test('an admin token does not grant conclude/cancel access to another user\'s cart', async ({
    admin,
    newActor,
  }) => {
    const owner = await newActor();
    const product = await newActor({ administrador: 'true' }).then((a) => a.produtos.seed({ quantidade: 10 }));
    await owner.carrinhos.seed([{ idProduto: product.id, quantidade: 2 }]);

    const res = await admin.carrinhos.cancelarCompra();
    expectStatus(res, 200);
    expect(
      res.body.message,
      'an admin token must act on the admin\'s own (nonexistent) cart, never someone else\'s',
    ).toMatch(/não foi encontrado carrinho/i);

    expect(await stockOf(admin, product.id), "the owner's stock must be unaffected by the admin's no-op").toBe(8);
  });
});
