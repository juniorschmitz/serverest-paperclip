import { test, expect } from '@/fixtures';

/**
 * Automation order #6 (slow half) — F4: the one auth state nobody had driven
 * live before this suite (strategy §10 gap G4, findings.md S4). The exploratory
 * pass deferred it here specifically because it needs a *genuinely* elapsed
 * 600-second token, not a hand-forged one — a forged signature and an expired
 * signature can legitimately fail differently, and only one of them is the
 * case this test exists to prove.
 *
 * Kept in its own file, away from every other token/auth test, for one reason:
 * it is the single slowest thing in this suite by two orders of magnitude
 * (10+ minutes of real wall-clock waiting, not CPU), so it must never share a
 * test run with fast tests whose reliability signal would otherwise be buried
 * under it — or worse, silently tax every ordinary `--project=api` run by 10+
 * minutes just because this file matches the same `.api.spec.ts` pattern.
 *
 * That is why it is tagged `@slow` and excluded by playwright.config.ts's
 * `grepInvert` by default. The only way to run it is the explicit escape
 * hatch (CLI `--grep` does not override a config-level `grepInvert` — they
 * AND together, verified with `--list` before relying on it):
 *
 *   RUN_SLOW=1 npx playwright test --project=api --grep "600s-expired"
 *
 * Run it on its own reliability pass, and expect ~3, not the usual 10:
 *   RUN_SLOW=1 npm run reliability -- 3 --project=api --grep "600s-expired"
 * At ~10 minutes per run the usual bar would cost 100+ minutes of pure
 * waiting for a mechanism with no branching left to find flake in once the
 * live run has proven it once; see TES-8's run record for how that trade-off
 * was reported rather than silently shipped as "10/10".
 */
test.describe('@slow F4 token expiry', () => {
  test('a genuinely 600s-expired token is rejected with 401, the same as an invalid one', async ({
    newActor,
    anonApi,
  }) => {
    // This test's entire runtime is the wait, so give it the room the default
    // 60s test timeout does not.
    test.setTimeout(11 * 60 * 1000);

    const actor = await newActor();
    const mintedHeader = await actor.api.tokenManager.authHeader(actor.user.credentials);
    const declaredTtl = actor.api.tokenManager.declaredTtlSeconds(actor.user.credentials);
    expect(declaredTtl, 'the TTL this test waits out must be the TTL the server actually declared').toBe(
      600,
    );

    // Wait past the server's own exp claim, plus a safety margin for clock
    // skew between this machine and the server — the margin only needs to
    // cover skew, not the TTL itself, so it stays small next to the 600s wait.
    const waitMs = (declaredTtl! + 5) * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    // cancelar-compra, not GET /produtos: GET /produtos needs no auth at all
    // (checklist F17/F11), so it could never prove a token was rejected.
    // cancelar-compra requires *some* valid token regardless of admin status
    // or cart ownership, and needs no seeded product/cart of its own.
    // rawAuthorization sends this exact header and disables ApiClient's
    // auto-retry-on-expired-token, so the 401 this test is asserting on
    // cannot be silently swallowed and re-minted away.
    const res = await anonApi.delete('/carrinhos/cancelar-compra', { rawAuthorization: mintedHeader });
    expect(res.status, 'a token past its declared 600s life must be rejected like any other invalid one').toBe(
      401,
    );
    expect(String((res.body as { message?: string }).message ?? '').toLowerCase()).toContain('expirado');
  });
});
