# ServeRest CompassUOL — Playwright test suite

API and UI test automation for `https://compassuol.serverest.dev`, built by
Testing CIA.

This is the framework scaffold (TES-7). The test cases themselves are TES-8 and
follow the coverage map from TES-5. What is here is the machinery every one of
those tests will sit on, plus enough real tests to prove the machinery works
end to end.

---

## Getting started

```bash
npm install
npx playwright install chromium
npm test
```

That is the whole setup. There are no credentials to obtain and no VPN: the
target is a public instance, and the suite creates every account it needs.

**If you are on the client network, do this first.** The corporate Zscaler proxy
re-signs HTTPS with a root CA that Windows trusts and Node does not, so `curl`
works while Playwright fails with `unable to get local issuer certificate`:

```bash
npm run ca                              # exports the corporate root CA
export NODE_EXTRA_CA_CERTS="<path it prints>"    # bash
$env:NODE_EXTRA_CA_CERTS = "<path it prints>"    # PowerShell
```

It must be set in the shell environment, not in `.env` — Node reads it when the
process starts, which is before `.env` is loaded. CI runners are not behind the
proxy and need none of this. We do **not** use `ignoreHTTPSErrors` or
`NODE_TLS_REJECT_UNAUTHORIZED=0`: both switch certificate verification off for
the whole suite, which would make a genuine certificate regression on the app
under test invisible.

### Commands

| Command | What it does |
|---|---|
| `npm test` | Everything — API and UI |
| `npm run test:api` | API only; no browser, a few seconds |
| `npm run test:ui` | UI only |
| `npm run test:smoke` | The `@smoke` journeys |
| `npm run test:headed` | UI with a visible browser |
| `npm run report` | Open the HTML report from the last run |
| `npm run reliability` | Run the suite 10× and fail if any run is red |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run ca` | Export the corporate root CA (see above) |

---

## Layout

```
playwright.config.ts        projects, artifacts, timeouts, retries
src/
  config/
    environments.ts         one block per environment + the forbidden-host list
    env.ts                  resolution, env-var overrides, the production guard
  api/
    endpoints.ts            all 16 operations as path templates
    api-client.ts           the single path every request takes
    token-manager.ts        JWT lifecycle
    types.ts                response shapes
    clients/                one per domain: usuarios, produtos, carrinhos
  data/
    identity.ts             unique emails and names
    factories.ts            request-body builders with overrides
  pages/                    page objects (UI)
  support/
    contract.ts             validation against the live swagger.json
    resource-registry.ts    ordered teardown
    ui-origin-rewrite.ts    points the shipped UI at our backend
    assertions.ts           shared assertions
    retry.ts                transport-level retry, worker setup only
  fixtures/
    test.ts                 the fixture layer — the whole author-facing surface
tests/
  smoke/                    end-to-end journeys, API and UI
  scaffold/                 tests of the framework itself
scripts/
  reliability.mjs           the 10-consecutive-runs gate
  export-corporate-ca.mjs   proxy CA exporter
docs/
  selector-strategy.md      how to write a locator that survives a redesign
  shared-sandbox-rules.md   how to write a test against a shared instance
  ui-origin-rewrite.md      the spike, its result and its evidence
```

## Writing a test

One import, always:

```ts
import { test, expect } from '@/fixtures';
```

Importing `test` from `@playwright/test` directly bypasses the fixture layer,
and with it token refresh, seeding and cleanup.

```ts
test('a non-admin cannot create a product', async ({ newActor }) => {
  const user = await newActor({ administrador: 'false' });

  const res = await user.produtos.create(buildProduct());

  expectStatus(res, 403);
  expectContract(res);
});
```

Nothing in that test logs in, mints a token, or deletes the user afterwards. All
three happen anyway.

### The fixtures

| Fixture | What you get |
|---|---|
| `admin` | A freshly seeded `administrador`, with clients bound to it |
| `newActor(opts)` | Seed another identity — call it twice for two users |
| `anonApi` | A client that sends no `Authorization` header |
| `usuarios` | User endpoints unauthenticated (they need no token) |
| `pages` | Page objects against the current page |
| `originRewrite` | Handle on the UI origin rewrite, for assertions |
| `registry` | Teardown bookkeeping; only needed for hand-registered cleanup |
| `contract` | The OpenAPI validator (worker-scoped) |

Domain clients split into two kinds of method, and the split matters:

- **Raw** — `create`, `list`, `getById`, `update`, `remove`. Send the request and
  return it unjudged. Use these for the thing under test, including negative
  cases: a helper that asserts 201 internally is useless in a test whose point
  is that it should be a 400.
- **`seed()`** — arranges state. Asserts success, registers teardown, returns a
  typed handle. Use for the *given* part of a test, never the *when*.

---

## The decisions worth knowing about

Four constraints shaped this scaffold. Each one is expensive to retrofit, which
is why they are handled at the framework layer rather than left to tests.

### The JWT lives 600 seconds

Measured, `iat` to `exp`. A suite that mints one token in global setup and shares
it starts failing about ten minutes in, and the failures land on whichever test
happens to be running — which looks exactly like flake and moves around between
runs.

So there is no shared token, no global-setup capture and no storage state on
disk. Each worker owns a `TokenManager` that mints lazily per identity and
re-mints when the token is within 120 seconds of expiry. `ApiClient` attaches the
header **per request** rather than via `extraHTTPHeaders`, because a header fixed
at request-context creation would pin one token for the worker's whole life.

Belt and braces: a 401 whose body names an expired token triggers exactly one
re-mint and retry — but only for managed tokens, so a test that deliberately
sends a bad token still gets its 401.

### There is no CompassUOL front-end

The only ServeRest UI has `https://serverest.dev` compiled into its bundle — a
different backend. Every request the page makes to that origin is intercepted
and served from the instance under test instead.

**This was spiked before anything was built on it, and it works.** See
`docs/ui-origin-rewrite.md` for the evidence, including the control assertion
that proves a user registered through the UI landed on our instance and *not* on
the public one. The rewrite is installed by the `page` fixture, so no UI test can
forget it, and `assertRewroteApiTraffic()` fails loudly if a future front-end
deploy changes the hardcoded origin.

### It is a shared public sandbox

Other people are writing to it while we run. Everything is self-seeded, every
generated value is unique, all cleanup is ordered and runs on failure, and
`quantidade` is marked `@deprecated` so nobody asserts on a global count by
accident. Read `docs/shared-sandbox-rules.md` before writing a test.

### The spec is machine-readable, so use it

The API publishes a complete OpenAPI 3.0 document at `/swagger.json` covering all
16 operations. Every response the suite receives is validated against it, for the
cost of one fetch per worker. It catches the class of regression no hand-written
assertion will: a field that changes type, a field that quietly disappears.

The spec is fetched live, not vendored — a vendored copy validates against what
the API used to be. Default posture is report-not-fail, so a shape mismatch on an
undocumented error status shows up in the report instead of turning a valid
functional test red. `STRICT_CONTRACT=true` makes drift a hard failure, which is
how a dedicated contract job should run it.

### Retries are zero, deliberately

In CI as well as locally. A retry converts a real intermittent defect into a
green run, and the suite stops being able to tell anyone the truth. The tools for
flake here are unique test data, no shared token, no assertions on shared state,
and web-first assertions — not a second attempt.

`npm run reliability` is the gate instead: it runs the suite ten times and fails
if any single run is red. A test ships after ten consecutive green runs.

---

## Configuring environments

`TEST_ENV` selects a block from `src/config/environments.ts`; any individual
value can be overridden by an environment variable, so pointing the suite
somewhere new needs no code change:

```bash
TEST_ENV=staging npm test
API_BASE_URL=https://other.example.com npm run test:api
```

See `.env.example` for every supported variable.

`FORBIDDEN_HOSTS` in `environments.ts` is a denylist the suite refuses to run
against — `env.ts` throws at startup. It currently holds `serverest.dev`, the
public reference instance. Add real production hostnames there when the client's
own application arrives; the engagement rule is that we never test against
production, and a rule that lives only in a document eventually gets broken by a
stray environment variable.

## When something fails

Traces, video and screenshots are captured on failure and kept:

```bash
npm run report                                  # HTML report, links all three
npx playwright show-trace test-results/<test>/trace.zip
```

`retain-on-failure` rather than `on-first-retry`, because with retries at zero
`on-first-retry` would capture nothing, ever.

JUnit XML lands at `test-results/junit.xml` for whoever wires this into CI.

Report a failure as a **product bug** or a **test bug**, explicitly, every time.
A product bug gets its own issue with a runnable `curl` reproduction. Application
source is never changed to make a test pass.

## Known state

- **The repository is local only — there is no remote configured**, and no push
  credential on this machine. The scaffold is committed on the test branch
  `test/tes-7-playwright-scaffold`. When a remote is provided it can be pushed
  as-is; nothing here assumes a particular host.
- `certs/` and `.env` are machine-local and git-ignored.

## Related work in this repo

This scaffold is one piece of a larger engagement, and other files here belong to
teammates. Read theirs rather than duplicating them:

| Document | Owner | What it covers |
|---|---|---|
| `strategy.md` | QA Strategy Lead | Test strategy, coverage map, layer split (TES-5) |
| `findings.md` | Exploratory Tester | Exploratory session findings (TES-6) |
| `docs/ci.md`, `.github/workflows/` | Test Infra & CI Engineer | Pipeline, sharding, artifacts (TES-9) |
| `docs/flake-policy.md`, `docs/quarantine.md` | Test Infra & CI Engineer | What happens when a test is unstable |
| `tools/staging-readiness-probe.mjs` | Chief of Staff | Environment readiness probe (TES-3) |

The CI workflows drive this scaffold through `npm run typecheck`, `npm ci` and
`npx playwright test --project=... --reporter=blob`, and set `TEST_ENV`,
`TEST_RUN_ID`, `API_BASE_URL`, `UI_BASE_URL` and `WORKERS` — all of which this
project reads. Changing an npm script name or an environment variable here
breaks their pipeline, so check `.github/workflows/tests.yml` before renaming
either.

`scripts/reliability.mjs` (this scaffold) answers *"is this test ready to
ship?"*. `scripts/flake-scan.mjs` (CI Engineer) answers *"which test is
unstable?"*. They are complementary; both are documented in
`docs/flake-policy.md`.
