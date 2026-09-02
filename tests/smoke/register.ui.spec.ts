import { test, expect } from '@/fixtures';
import { buildUser } from '@/data/factories';
import { config } from '@/config/env';
import type { UsuarioListBody } from '@/api/types';

/**
 * The origin-rewrite spike, kept as a permanent test.
 *
 * The question it answers: when we load front.serverest.dev — whose bundle has
 * https://serverest.dev compiled in — and rewrite its API traffic, does a user
 * registered through that UI actually land on the instance under test?
 *
 * It is a spike result and a regression guard at once. If a future deploy of
 * the front-end changes its API origin, or the rewrite stops working, this
 * fails loudly here rather than silently turning every other UI test into a
 * test of somebody else's backend.
 *
 * The third step is the one that makes the whole UI layer trustworthy: it
 * asserts the user is present on the target *and absent from the origin the
 * bundle wanted to talk to*. Presence alone would not distinguish "the rewrite
 * worked" from "the rewrite did nothing and both instances happen to have a
 * user with this email".
 */
test.describe('@smoke @spike UI registration through the rewritten origin', () => {
  test('a user registered in the UI lands on the instance under test', async ({
    page,
    pages,
    anonApi,
    originRewrite,
    registry,
    playwright,
  }) => {
    const user = buildUser({ administrador: 'true' });

    await test.step('register through the shipped front-end', async () => {
      await pages.register.goto();
      await pages.register.register(user);

      // Web-first assertion: waits for the admin dashboard to render rather
      // than sleeping or polling the URL.
      await expect(
        pages.adminHome.cadastrarUsuarios,
        'registering as administrador should land on the admin dashboard',
      ).toBeVisible();
      expect(pages.adminHome.currentPath()).toBe('/admin/home');
    });

    await test.step('the UI talked to the instance under test, not the hardcoded one', () => {
      originRewrite.assertRewroteApiTraffic();

      const registration = originRewrite.records.find(
        (r) => r.method === 'POST' && r.from.endsWith('/usuarios'),
      );
      expect(
        registration,
        `no POST /usuarios was intercepted. Rewrites seen: ` +
          `${originRewrite.records.map((r) => `${r.method} ${r.from}`).join(', ') || '(none)'}`,
      ).toBeDefined();
      expect(registration?.to).toBe(`${config().apiBaseUrl}/usuarios`);
      expect(registration?.status).toBe(201);
    });

    const userId = await test.step('the user exists on the target, by API', async () => {
      const res = await anonApi.get('/usuarios', { query: { email: user.email } });
      expect(res.status).toBe(200);

      const body = res.body as UsuarioListBody;
      const found = body.usuarios.find((u) => u.email === user.email);
      expect(
        found,
        `GET /usuarios?email=${user.email} on ${config().apiBaseUrl} did not return the user ` +
          `the UI just registered`,
      ).toBeDefined();
      expect(found!.nome).toBe(user.nome);
      expect(found!.administrador).toBe('true');

      // The browser created it, so the registry does not know about it yet.
      // Register the delete now so teardown removes it even if a later step
      // fails.
      const id = found!._id;
      registry.track('usuario', `${id} (${user.email}, created via UI)`, async () => {
        const del = await anonApi.delete('/usuarios/{_id}', { pathParams: { _id: id } });
        if (del.status >= 400) throw new Error(`DELETE /usuarios/${id} -> ${del.status}`);
      });

      return id;
    });

    await test.step('and does NOT exist on the origin the bundle hardcodes', async () => {
      // A single read-only GET against the public reference instance, as a
      // control. It is the only place in the suite that touches that host, it
      // writes nothing, and it is why the rewrite can be trusted. The suite
      // itself cannot be pointed there: that host is on FORBIDDEN_HOSTS in
      // src/config/environments.ts and env.ts refuses to start.
      const control = await playwright.request.newContext();
      try {
        const res = await control.get(`${config().uiHardcodedApiOrigin}/usuarios`, {
          params: { email: user.email },
          failOnStatusCode: false,
        });
        const body = (await res.json()) as UsuarioListBody;
        expect(
          body.usuarios.map((u) => u.email),
          `the user leaked to ${config().uiHardcodedApiOrigin} — the rewrite did not hold, ` +
            `so UI tests would be exercising the wrong backend`,
        ).not.toContain(user.email);
      } finally {
        await control.dispose();
      }

      expect(userId, 'sanity: we did find the user on the target').toBeTruthy();
    });

    await test.step('the page is on the UI host, only its API calls were moved', () => {
      expect(new URL(page.url()).origin).toBe(config().uiBaseUrl);
    });
  });
});
