import { test, expect } from '@/fixtures';
import { ResourceRegistry } from '@/support/resource-registry';
import { buildProduct, buildUser } from '@/data/factories';

/**
 * Tests of the scaffold itself.
 *
 * These do not test the application. They test the machinery every other test
 * silently depends on, and they exist because that machinery can fail in the
 * one way that matters most: quietly, while still reporting green.
 *
 * The contract check below is the case in point. The validator originally built
 * a JSON pointer without its "#", so ajv could not resolve a single schema,
 * every response was classified "not documented in the spec", and the contract
 * layer passed everything while checking nothing. Nothing went red. The only
 * symptom was a line in the log that looked like a spec gap rather than a bug
 * in our code.
 */
test.describe('scaffold self-checks', () => {
  test('the contract validator can compile every response the spec documents', async ({
    contract,
  }) => {
    const { compiled, failed } = contract.compileAll();

    expect(
      failed,
      `Some documented response schemas would not compile, so responses on those operations ` +
        `are silently skipped rather than validated`,
    ).toEqual([]);

    // The spec has 16 operations; each documents several statuses. A sharp drop
    // here means the spec shrank or the pointer logic broke again.
    expect(compiled.length, 'expected the full documented response surface').toBeGreaterThanOrEqual(
      38,
    );
  });

  test('contract validation actually rejects a wrong shape', ({ contract }) => {
    // Proves the validator is live. If this passes when it should fail, the
    // layer is a no-op again.
    const good = contract.validate('post', '/usuarios', 201, {
      message: 'Cadastro realizado com sucesso',
      _id: 'abc123',
    });
    expect(good.documented, 'POST /usuarios 201 is documented in swagger.json').toBe(true);
    expect(good.ok, `unexpected errors: ${good.errors.join('; ')}`).toBe(true);

    const bad = contract.validate('post', '/usuarios', 201, { message: 42, _id: [] });
    expect(bad.documented).toBe(true);
    expect(bad.ok, 'a body with the wrong field types must not validate').toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  test('generated identities are unique across many draws', () => {
    // Email and product-name uniqueness are enforced by the API, so a collision
    // shows up as a failed test that looks like a product bug. 500 draws is far
    // more than any single run makes.
    const emails = new Set<string>();
    const productNames = new Set<string>();

    for (let i = 0; i < 500; i += 1) {
      emails.add(buildUser().email);
      productNames.add(buildProduct().nome);
    }

    expect(emails.size, 'duplicate email generated').toBe(500);
    expect(productNames.size, 'duplicate product name generated').toBe(500);
  });

  test('teardown deletes carts before products before users', async () => {
    // The API refuses to delete a product that sits in a cart, or a user who
    // owns one. Order is therefore a correctness property of teardown, not a
    // preference — and it is worth pinning, because the registry hands out no
    // other signal when it gets this wrong: cleanup just fails and warns.
    const order: string[] = [];
    const registry = new ResourceRegistry();

    // Registered deliberately in the wrong order.
    registry.track('usuario', 'u1', async () => void order.push('usuario'));
    registry.track('produto', 'p1', async () => void order.push('produto'));
    registry.track('carrinho', 'c1', async () => void order.push('carrinho'));

    const report = await registry.dispose();

    expect(order).toEqual(['carrinho', 'produto', 'usuario']);
    expect(report.deleted).toBe(3);
    expect(report.failures).toEqual([]);
  });

  test('a failing cleanup is reported, not thrown', async () => {
    // Teardown must never replace the reason a test failed with the reason its
    // cleanup failed. The registry collects failures and keeps going.
    const registry = new ResourceRegistry();
    registry.track('produto', 'p-broken', async () => {
      throw new Error('still in a cart');
    });
    registry.track('usuario', 'u-ok', async () => {});

    const report = await registry.dispose();

    expect(report.attempted).toBe(2);
    expect(report.deleted).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.label).toContain('p-broken');
    expect(report.failures[0]?.reason).toContain('still in a cart');
  });
});
