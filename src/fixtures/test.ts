import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';

import { config } from '@/config/env';
import { ApiClient } from '@/api/api-client';
import { TokenManager } from '@/api/token-manager';
import { UsuariosClient, type SeededUser } from '@/api/clients/usuarios.client';
import { ProdutosClient } from '@/api/clients/produtos.client';
import { CarrinhosClient } from '@/api/clients/carrinhos.client';
import { ContractValidator } from '@/support/contract';
import { ResourceRegistry } from '@/support/resource-registry';
import { installOriginRewrite, type OriginRewriteHandle } from '@/support/ui-origin-rewrite';
import { processIdentity } from '@/data/identity';
import { AdminHomePage, LoginPage, RegisterPage, ShopHomePage } from '@/pages';

/**
 * The fixture layer. This is the whole public surface a test author uses.
 *
 * Design rules it enforces, so no individual test has to remember them:
 *
 *   - No shared token, ever. Each worker owns a TokenManager that mints per
 *     identity and refreshes inside the 600-second TTL.
 *   - No pre-existing data. Every actor and every record is seeded by the test
 *     that needs it.
 *   - Everything created is deleted, in dependency order, in teardown that runs
 *     on failure as well as success.
 *   - Every response is checked against swagger.json on the way past.
 *   - The UI is repointed at the backend under test before the first request.
 */

/** A seeded identity plus domain clients already bound to it. */
export interface Actor {
  user: SeededUser;
  api: ApiClient;
  usuarios: UsuariosClient;
  produtos: ProdutosClient;
  carrinhos: CarrinhosClient;
}

export interface WorkerFixtures {
  apiRequest: APIRequestContext;
  contract: ContractValidator;
  tokens: TokenManager;
}

export interface TestFixtures {
  /** Tracks what to delete. Disposed automatically; tests rarely touch it. */
  registry: ResourceRegistry;
  /** Unauthenticated client. The starting point for auth-boundary tests. */
  anonApi: ApiClient;
  /** User endpoints need no token, so this is bound to nobody. */
  usuarios: UsuariosClient;
  /** Seed a new identity with its own clients. Each call is a distinct user. */
  newActor: (overrides?: { administrador?: 'true' | 'false' }) => Promise<Actor>;
  /** A ready-made administrador. Seeded on first use, not before. */
  admin: Actor;
  /** Handle on the UI origin rewrite. Installed automatically with `page`. */
  originRewrite: OriginRewriteHandle;
  /** Page objects, constructed against the current page. */
  pages: {
    register: RegisterPage;
    login: LoginPage;
    adminHome: AdminHomePage;
    shopHome: ShopHomePage;
  };
}

/**
 * The rewrite handle for a given page.
 *
 * The `page` fixture is overridden below so that every UI test gets the rewrite
 * without asking — leaving it opt-in means one day somebody forgets and quietly
 * tests the wrong backend. The handle is stashed here so the `originRewrite`
 * fixture can hand it back for assertions.
 */
const rewriteHandles = new WeakMap<Page, OriginRewriteHandle>();

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // ---------------------------------------------------------------- worker

  apiRequest: [
    async ({ playwright }, use) => {
      const context = await playwright.request.newContext({
        // Deliberately no Authorization in extraHTTPHeaders: a header fixed at
        // context creation would pin one token for the worker's whole life,
        // which is exactly what a 600-second TTL punishes. ApiClient attaches
        // auth per request instead.
        extraHTTPHeaders: { 'Content-Type': 'application/json' },
      });
      await use(context);
      await context.dispose();
    },
    { scope: 'worker' },
  ],

  contract: [
    async ({ apiRequest }, use, workerInfo) => {
      const validator = await ContractValidator.load(apiRequest);
      const { runId, procId } = processIdentity();
      const info = validator.info;
      // One line per worker. When a run is questioned three weeks from now,
      // this is what says which environment and which spec version it hit.
      // eslint-disable-next-line no-console
      console.log(
        `[worker ${workerInfo.workerIndex}] env=${config().envKey} api=${config().apiBaseUrl} ` +
          `spec=${info.title} v${info.version} (${info.operations} ops) run=${runId} proc=${procId}`,
      );
      await use(validator);

      if (validator.undocumented.size > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[worker ${workerInfo.workerIndex}] statuses not documented in swagger.json: ` +
            `${[...validator.undocumented].join(', ')}`,
        );
      }

      // Louder than "undocumented", and deliberately so: a schema the spec
      // documents but we could not compile means we validated nothing on that
      // operation while reporting no errors.
      if (validator.compileFailures.size > 0) {
        // eslint-disable-next-line no-console
        console.error(
          `[worker ${workerInfo.workerIndex}] CONTRACT VALIDATOR DEGRADED — ` +
            `${validator.compileFailures.size} documented schema(s) failed to compile and were ` +
            `not checked: ${[...validator.compileFailures.entries()]
              .map(([op, reason]) => `${op} (${reason})`)
              .join('; ')}`,
        );
      }
    },
    { scope: 'worker' },
  ],

  tokens: [
    async ({ apiRequest }, use) => {
      await use(new TokenManager(apiRequest));
    },
    { scope: 'worker' },
  ],

  // ------------------------------------------------------------------ test

  registry: async ({}, use) => {
    const registry = new ResourceRegistry();

    await use(registry);

    // Runs whether the test passed or failed — that is the entire reason
    // cleanup lives in a fixture instead of afterEach in the test file.
    const report = await registry.dispose();
    if (report.failures.length > 0) {
      const detail = report.failures.map((f) => `${f.label}: ${f.reason}`).join('\n  ');
      const message =
        `Cleanup left ${report.failures.length} of ${report.attempted} resource(s) behind ` +
        `in the shared sandbox:\n  ${detail}`;
      if (config().strictCleanup) throw new Error(message);
      // eslint-disable-next-line no-console
      console.warn(`[cleanup] ${message}`);
    }
  },

  anonApi: async ({ apiRequest, tokens, contract }, use) => {
    await use(new ApiClient(apiRequest, tokens, contract));
  },

  usuarios: async ({ anonApi, registry }, use) => {
    await use(new UsuariosClient(anonApi, registry));
  },

  newActor: async ({ apiRequest, tokens, contract, registry }, use) => {
    const seedClient = new UsuariosClient(
      new ApiClient(apiRequest, tokens, contract),
      registry,
    );

    await use(async (overrides = {}) => {
      const user = await seedClient.seed(overrides);
      const api = new ApiClient(apiRequest, tokens, contract, user.credentials);
      return {
        user,
        api,
        usuarios: new UsuariosClient(api, registry),
        produtos: new ProdutosClient(api, registry),
        carrinhos: new CarrinhosClient(api, registry),
      };
    });
  },

  admin: async ({ newActor }, use) => {
    await use(await newActor({ administrador: 'true' }));
  },

  // -------------------------------------------------------------------- UI

  page: async ({ page }, use) => {
    const cfg = config();
    if (cfg.rewriteUiOrigin) {
      const handle = await installOriginRewrite(page, {
        fromOrigin: cfg.uiHardcodedApiOrigin,
        toOrigin: cfg.apiBaseUrl,
        verbose: process.env['DEBUG_REWRITE'] === '1',
      });
      rewriteHandles.set(page, handle);
      await use(page);
      await handle.dispose();
      return;
    }
    await use(page);
  },

  originRewrite: async ({ page }, use) => {
    const handle = rewriteHandles.get(page);
    if (!handle) {
      throw new Error(
        `No origin rewrite is installed. UI_REWRITE_ORIGIN is false for env ` +
          `"${config().envKey}", which means the UI is expected to already point at ` +
          `${config().apiBaseUrl}. A test asserting on the rewrite cannot run here.`,
      );
    }
    await use(handle);
  },

  pages: async ({ page }, use) => {
    await use({
      register: new RegisterPage(page),
      login: new LoginPage(page),
      adminHome: new AdminHomePage(page),
      shopHome: new ShopHomePage(page),
    });
  },
});

export { expect };
