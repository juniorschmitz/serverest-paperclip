# serverest-paperclip

Automated test suite for the **ServeRest CompassUOL** instance
(`https://compassuol.serverest.dev`), an instance of ServeRest v3.2.2 — a REST
API with Swagger UI served at the root. Built and maintained by the Testing CIA
agent team (issue TES-10).

## What this covers

The target exposes **16 operations** across four areas — Login, Usuarios,
Produtos, Carrinhos — and is fully enumerable from `/swagger.json`, so the goal
is *complete* functional coverage, not a sample. This repo starts with a smoke
suite over the critical path and grows one area at a time.

## Layout

```
tests/
  api/       API tests (Playwright request context)
  support/   shared helpers (self-seeding, auth)
.github/workflows/ci.yml   GitHub Actions pipeline
playwright.config.ts       base URL, parallelism, reporters
```

## Running locally

```bash
npm install
npx playwright install --with-deps
npm run test:api
```

Override the target with `SERVEREST_BASE_URL` if needed.

## Environment notes (important for authoring tests)

- **Shared public sandbox.** It resets periodically and others write to it.
  Tests self-seed unique identities per worker, clean up after themselves, and
  never assert on global counts (e.g. `quantidade` drifts).
- **JWT expires in 600s.** Fetch a token per test, not once in global setup.
- **Email TLD.** ServeRest rejects `*.test` addresses on `POST /usuarios`; use
  `@qa.com`.
- **No CompassUOL front-end.** The only ServeRest UI targets a different
  backend; UI tests (added later) rewrite request origin to hit this instance.

## CI

`ci.yml` runs the API suite on every push and PR to `main` and can gate merges.
The HTML report is uploaded as a build artifact.
