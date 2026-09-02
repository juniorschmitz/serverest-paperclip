# Writing tests against a shared public sandbox

`compassuol.serverest.dev` is not ours alone. It is publicly reachable, other
people are creating and deleting records while our suite runs, and it resets
periodically. Every rule below exists because breaking it produces a failure
that looks like a product bug and is not one — and a suite that cries wolf gets
ignored, which is a worse outcome than having no suite.

## 1. Seed everything. Assume nothing exists.

No test may depend on a user, a product or an id that it did not create. There
is no "test admin account"; there is no seed data. The `admin` and `newActor`
fixtures create a fresh identity per test.

```ts
// good
test('...', async ({ admin }) => {
  const product = await admin.produtos.seed({ preco: 250 });
});

// wrong — this id will not exist tomorrow, or on the next reset
const PRODUCT_ID = 'BeeJh5lz3k6kSIzA';
```

## 2. Never assert on a global count.

`GET /usuarios` returns a `quantidade`. It is a count of everybody's records,
changing under you while the test runs. Asserting on it is guaranteed flake.

```ts
// wrong
expect(res.body.quantidade).toBe(4);

// right — asserts about our record, immune to other tenants
expectListContains(res, res.body.usuarios, seeded.id);
```

Every `quantidade` field in `src/api/types.ts` is marked `@deprecated` for this
reason. It is not really deprecated — the API returns it and the contract tests
need it — but the marker makes it strike through in the editor and trip a lint
rule, so reaching for it is a decision rather than an accident.

The same reasoning bans positional access on shared lists: `usuarios[0]` is a
different record from one minute to the next. Find by the id or name your test
created.

## 3. Uniqueness is enforced by the API, so generate it.

Two constraints will fail a test if violated:

- user email must be unique — `POST /usuarios` → 400 *"Este email já está sendo usado"*
- product name must be unique — `POST /produtos` → 400 *"Já existe produto com esse nome"*

Both are *global*, so a hardcoded name collides not only with your parallel
workers but with whatever another user of the sandbox created last week. Always
go through the factories in `src/data/factories.ts`; they draw from
`src/data/identity.ts`, which combines a run id, a per-process random component
and a counter.

One quirk worth knowing: the API validates email properly, and rejects
reserved-looking TLDs. `@example.local` fails with *"email deve ser um email
válido"*. The default domain is `qa.testcia.dev`, which also has the benefit of
identifying our data to anyone else looking at the instance.

## 4. Delete what you create, in teardown, in the right order.

Cleanup lives in the `registry` fixture, not in `afterEach`, because fixture
teardown runs even when the test fails. Anything created through `seed()` is
registered automatically. Anything created another way — through the UI, say —
must be registered by hand:

```ts
registry.track('usuario', `${id} (created via UI)`, async () => {
  await anonApi.delete('/usuarios/{_id}', { pathParams: { _id: id } });
});
```

Order is a correctness property, not a preference. The API enforces referential
rules: a product in a cart cannot be deleted, and a user who owns a cart cannot
be deleted. The registry always disposes **carts → products → users**, newest
first within each kind.

Cleanup failures are collected and warned about, never thrown — a cleanup error
thrown from teardown would overwrite the real reason the test failed, which is
the most unhelpful thing a suite can do to whoever is debugging it. Set
`STRICT_CLEANUP=true` in a nightly job if you want leaks to be loud.

## 5. One cart per user.

The API allows a user exactly one cart. A test that needs two carts needs two
users — `newActor()` twice. `seed()` says so in its failure message, because
this is the mistake everyone makes once.

Teardown cancels rather than concludes: cancelling returns the stock we
borrowed. If the test already concluded the purchase, the cancel is a no-op the
API answers with 200, and the registry treats that as success.

## 6. Do not stress it.

Load testing, and destructive testing generally, are out of scope on this
engagement — the plan says so, and it is a shared instance we do not own. We
test it; we do not hammer it. Parallelism is capped at 4 workers.

**This is not just policy — ServeRest enforces it.** The instance ships its own
anti-load-test detector and answers with a blanket `429`
(`"Foi detectado comportamento equivalente a teste de carga, não execute teste
de carga nesse ambiente"`) once it judges the request rate from an IP looks like
load testing. It is instance-wide, not per-endpoint or per-token, and every
in-flight request pays for it — `POST /usuarios` inside `seed()`, a
`swagger.json` worker-setup fetch, a teardown delete, all come back 429 the
same way once it trips.

Measured directly (2026-09-02): ten consecutive full-suite runs (`npm run
reliability -- 10 --project=api`) fired back-to-back with no gap between them
failed **5 of 10** on 429s. The same ten runs with an 8-second cooldown between
them (now the default in `scripts/reliability.mjs`, `--cooldown` to change it)
were clean. The trigger is cumulative request *rate*, not any single run's
volume — a lone run of the suite does not approach it.

**Consequence for whoever builds TES-9 (CI):** anything that fires multiple
full-suite runs close together against this instance — concurrent shards
without staggering, `flake-scan.mjs`'s nightly N repeats, two workflows
triggered back to back — can reproduce this. If the gate goes red with 429s in
the failure body, this is why, and it is an environmental rate limit, not a
product defect or a flaky test; retrying will not help (see §1's reasoning) but
pacing will. `scripts/reliability.mjs`'s cooldown is one instance of the fix;
CI needs its own answer to the same constraint, whatever shard/schedule shape
it ends up with.
