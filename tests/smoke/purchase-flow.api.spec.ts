import { test, expect } from '@/fixtures';
import { expectContract, expectListContains, expectStatus } from '@/support/assertions';
import type { Carrinho, Produto } from '@/api/types';

/**
 * The scaffold's end-to-end proof at the API layer.
 *
 * This is deliberately a *journey*, not a set of endpoint checks: register an
 * administrador, list them, create a product, put it in a cart, read the cart
 * back, complete the purchase. If the scaffold's seeding, token handling,
 * contract validation and teardown all work, this passes; if any one of them is
 * broken, this fails.
 *
 * It is not the coverage suite. Per-operation happy-path and negative cases,
 * and the cart stock invariants, belong to TES-8 and the coverage map.
 */
test.describe('@smoke API purchase journey', () => {
  test('an administrador can register, create a product, and buy it', async ({
    admin,
    anonApi,
    usuarios,
  }) => {
    await test.step('the seeded administrador exists and is retrievable', async () => {
      const res = await anonApi.get('/usuarios/{_id}', { pathParams: { _id: admin.user.id } });
      expectStatus(res, 200);
      expectContract(res);

      const body = res.body as { email: string; administrador: string };
      expect(body.email).toBe(admin.user.payload.email);
      expect(body.administrador).toBe('true');
    });

    await test.step('the administrador appears in a filtered list', async () => {
      // Filtered by our own email, and asserted by containment. Never by
      // `quantidade`: other people are writing to this instance while we run.
      const res = await usuarios.list({ email: admin.user.payload.email });
      expectStatus(res, 200);
      expectContract(res);
      expectListContains(res, res.body.usuarios, admin.user.id);
    });

    const product = await test.step('create a product', async () => {
      // seed() asserts 201 and registers the delete. The token it uses was
      // minted lazily on this first authenticated call, not in global setup.
      const seeded = await admin.produtos.seed({ preco: 250, quantidade: 10 });

      const res = await admin.produtos.getById(seeded.id);
      expectStatus(res, 200);
      expectContract(res);
      expect((res.body as Produto).nome).toBe(seeded.payload.nome);

      return seeded;
    });

    const cart = await test.step('add it to a cart', async () => {
      return admin.carrinhos.seed([{ idProduto: product.id, quantidade: 2 }]);
    });

    await test.step('the cart reflects what was added', async () => {
      const res = await admin.carrinhos.getById(cart.id);
      expectStatus(res, 200);
      expectContract(res);

      const body = res.body as Carrinho;
      expect(body.idUsuario, 'the cart should belong to the user who created it').toBe(
        admin.user.id,
      );
      expect(body.produtos).toHaveLength(1);
      expect(body.produtos[0]?.idProduto).toBe(product.id);
      expect(body.produtos[0]?.quantidade).toBe(2);
      expect(body.precoTotal, '2 x 250').toBe(500);
    });

    await test.step('completing the purchase empties the cart', async () => {
      const concluded = await admin.carrinhos.concluirCompra();
      expectStatus(concluded, 200);
      expectContract(concluded);

      const gone = await admin.carrinhos.getById(cart.id);
      expect(
        gone.status,
        `the cart should not be retrievable after checkout, got ${gone.status}`,
      ).toBe(400);
    });
  });

  test('the token fixture mints lazily and reuses within its TTL', async ({ admin }) => {
    // Guards the design decision, not the product: if someone later moves token
    // capture into global setup, or drops the per-identity cache, this fails.
    const stats = admin.api.tokenManager.stats;
    const mintsBefore = stats.mints;

    await admin.produtos.list();
    expect(stats.mints, 'the first authenticated call should mint exactly one token').toBe(
      mintsBefore + 1,
    );

    await admin.produtos.list();
    await admin.produtos.list();
    expect(stats.mints, 'subsequent calls should reuse the cached token').toBe(mintsBefore + 1);

    // Assert the TTL the *server* declared (exp - iat). That is pure server-side
    // arithmetic, so it pins the 600s constraint exactly.
    //
    // The obvious version of this assertion — comparing `exp` against
    // Date.now() and expecting <= 600 — mixes two unsynchronised clocks. It
    // passed nine runs and failed the tenth with "601 <= 600", which is the
    // whole argument for the ten-run bar rather than one green run.
    expect(
      admin.api.tokenManager.declaredTtlSeconds(admin.user.credentials),
      'the API is documented and measured to issue 600-second tokens',
    ).toBe(600);

    // Local-clock view: loose bound only, enough to prove the token is fresh
    // and nowhere near the 120s refresh margin.
    const remaining = admin.api.tokenManager.secondsRemaining(admin.user.credentials);
    expect(remaining, 'a freshly minted token should not be near expiry').toBeGreaterThan(400);
  });
});
