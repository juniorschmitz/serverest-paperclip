import { test, expect } from '@/fixtures';
import { config } from '@/config/env';

/**
 * F22 / J5 (revised 2026-09-02, TES-22): UI login + authenticated browse.
 *
 * J5 originally named a full purchase journey through the rewritten origin
 * (item 10 in the automation order). TES-22 found that the shipped
 * front-end never calls `/carrinhos` at all — its "Lista de Compras" is
 * client-side/`localStorage` only, with zero `/carrinhos` mentions in either
 * JS chunk. There is no cart request for origin rewriting to intercept, so a
 * "complete the purchase" UI test would either fail the honesty guard
 * outright or pass while asserting only client-side state, falsely claiming
 * cross-stack cart coverage. Purchase/cart stays proven end-to-end at the API
 * layer (F1, F2, J1, J2 — TES-8 items 2-4, 9).
 *
 * What this test claims instead, honestly: a non-admin can log in through the
 * shipped front-end and see a product that exists on the instance under test,
 * with every step's API traffic verified to have actually reached that
 * instance and not the origin the bundle hardcodes. It is non-gating until it
 * has proven itself over the reliability bar (strategy §9.4).
 */
test.describe('@smoke UI login + authenticated browse via the rewritten origin', () => {
  test('a non-admin logs in and sees a real product from the instance under test', async ({
    page,
    pages,
    admin,
    newActor,
    originRewrite,
  }) => {
    const shopper = await newActor({ administrador: 'false' });
    const product = await admin.produtos.seed();

    await test.step('log in through the shipped front-end', async () => {
      await pages.login.goto();
      await pages.login.login(shopper.user.credentials);

      // Web-first assertion: waits for the storefront to render rather than
      // sleeping or polling the URL. The cart button is a real, stable
      // test id for this page (unlike `listaProdutos` — see shop-home.page.ts).
      await expect(
        pages.shopHome.cartButton,
        'logging in as a non-admin should land on the storefront',
      ).toBeVisible();
      expect(pages.shopHome.currentPath()).toBe('/home');
    });

    await test.step('the login went to the instance under test, not the hardcoded one', () => {
      const login = originRewrite.records.find(
        (r) => r.method === 'POST' && r.from.endsWith('/login'),
      );
      expect(
        login,
        `no POST /login was intercepted. Rewrites seen: ` +
          `${originRewrite.records.map((r) => `${r.method} ${r.from}`).join(', ') || '(none)'}`,
      ).toBeDefined();
      expect(login?.to).toBe(`${config().apiBaseUrl}/login`);
      expect(login?.status).toBe(200);
    });

    await test.step('browse: the seeded product, created via the API, is visible through the UI', async () => {
      // Search rather than scanning the raw list: the storefront is a shared
      // public sandbox and its product list is not ours to assert a count or
      // position on. Searching by the exact, generated-unique name is the
      // only way to find *our* record without depending on how many other
      // products happen to exist right now.
      await pages.shopHome.search(product.payload.nome);
      await expect(
        pages.shopHome.productCard(product.payload.nome),
        `product "${product.payload.nome}" was seeded via the API on ${config().apiBaseUrl} but ` +
          `did not appear in the UI's product list — either the rewrite silently failed on GET ` +
          `/produtos, or the browse query is not reaching the target`,
      ).toBeVisible();
    });

    await test.step('the browse traffic was also rewritten to the target', () => {
      const listCall = originRewrite.records.find(
        (r) => r.method === 'GET' && r.from.includes('/produtos'),
      );
      expect(
        listCall,
        `no GET /produtos was intercepted. Rewrites seen: ` +
          `${originRewrite.records.map((r) => `${r.method} ${r.from}`).join(', ') || '(none)'}`,
      ).toBeDefined();
      expect(listCall?.to.startsWith(`${config().apiBaseUrl}/produtos`)).toBe(true);
      expect(listCall?.status).toBe(200);

      originRewrite.assertRewroteApiTraffic(2);
    });

    await test.step('honesty check: this journey never touches /carrinhos, on either origin', () => {
      const cartCalls = originRewrite.records.filter((r) => r.from.includes('/carrinhos'));
      expect(
        cartCalls,
        `this test claims login + browse only (TES-22); a /carrinhos call means the shipped ` +
          `front-end's cart behaviour changed and the coverage map needs revisiting`,
      ).toHaveLength(0);
    });

    await test.step('the page stayed on the UI host; only its API calls were moved', () => {
      expect(new URL(page.url()).origin).toBe(config().uiBaseUrl);
    });
  });
});
