# Test Plan â€” ServeRest CompassUOL

**Target:** https://compassuol.serverest.dev/
**Application:** ServeRest v3.2.2 â€” REST API + Swagger UI
**Owner:** Chief of staff Â· **Team:** QA Strategy Lead, Exploratory Tester, Playwright Automation Engineer, Test Infrastructure & CI Engineer
**Status:** approved-pending â€” everything below is unblocked and in motion except CI, which needs one answer from you.

---

## 1. What we are actually testing

The URL resolves to the **ServeRest API host**, serving Swagger UI at the root. This was verified directly, not assumed:

| Fact | Evidence |
|---|---|
| Live, publicly reachable | `GET /` â†’ 200, `<title>ServeRest</title>`, no VPN or IP allowlist |
| API on the same host, no `/api` prefix | `GET /usuarios`, `/produtos`, `/carrinhos` â†’ 200 |
| Full machine-readable spec | `GET /swagger.json` â†’ 200, ServeRest v3.2.2, 16 operations |
| Accounts are self-serve | `POST /usuarios` with `administrador:"true"` â†’ 201 |
| Auth works, returns Bearer JWT | `POST /login` â†’ 200 |
| Permissive CORS | `access-control-allow-origin: *` |

**The surface is small and completely enumerable â€” 16 operations across 4 domains.** That is the single most important planning fact: full coverage is achievable, so this plan targets *complete* operation coverage rather than a risk-sampled subset.

```
Login      POST   /login

Usuarios   GET    /usuarios                     POST   /usuarios
           GET    /usuarios/{_id}               PUT    /usuarios/{_id}
           DELETE /usuarios/{_id}

Produtos   GET    /produtos                     POST   /produtos              [auth]
           GET    /produtos/{_id}               PUT    /produtos/{_id}        [auth]
           DELETE /produtos/{_id}               [auth]

Carrinhos  GET    /carrinhos                    POST   /carrinhos             [auth]
           GET    /carrinhos/{_id}
           DELETE /carrinhos/concluir-compra    [auth]
           DELETE /carrinhos/cancelar-compra    [auth]
```

Note the asymmetry worth probing: **`/usuarios` write operations declare no auth requirement** while `/produtos` and `/carrinhos` do. Anonymous user deletion and modification is the first thing to test, not the last.

---

## 2. Three constraints that shape the whole engagement

These were discovered during environment probing and are design inputs, not test cases.

### 2.1 The JWT expires in 600 seconds

Measured on a live token: `iat` â†’ `exp` is exactly 600s. Any suite that runs longer than ten minutes will fail mid-run on token expiry unless the framework refreshes. The fixture layer must own token lifecycle â€” never a token captured once in global setup.

### 2.2 There is no CompassUOL front-end

`front.serverest.dev` is the only ServeRest UI in existence, and its JS bundle **hardcodes `https://serverest.dev`** â€” a different backend. There is no runtime environment variable to repoint it. So UI tests run against it as-shipped would exercise the wrong instance and prove nothing about yours.

**Recommendation â€” Playwright `page.route()` origin rewriting.** Load `front.serverest.dev` for the UI, and intercept every request to `serverest.dev`, rewriting the origin to `compassuol.serverest.dev`. This works because the target sends `access-control-allow-origin: *`. It gives genuine UI-on-your-backend coverage with no build step and no repo access.

Alternatives, for the record: build the open-source front-end locally with the API base repointed (heavier, needs Node tooling, but the most faithful); or accept UI coverage against the public instance and treat it as ServeRest-version regression only (cheapest, weakest). **We are proceeding with route rewriting** and will report if it proves unstable.

### 2.3 It is a shared public sandbox

Not exclusively ours, and it resets periodically. Consequences the framework must respect:

- **Self-seed everything.** No test may assume pre-existing data â€” not a user, not a product, not an ID.
- **Unique identities per run.** Email collisions across parallel workers are the likeliest source of false failures.
- **Clean up.** Delete what you create, in an `afterEach` that runs even on failure.
- **Never assert on global counts.** `GET /usuarios` returns a `quantidade` that other people are changing while you test. Asserting on it produces flake, and flake destroys trust in the suite faster than missing coverage does.

---

## 3. Risk register â€” what we test first

Ordered by expected value, not by endpoint order. This is the priority the team works to.

| # | Risk | Why it ranks here | Owner |
|---|---|---|---|
| R1 | **Authorisation bypass on `/usuarios`** â€” spec declares no auth on write ops | Anonymous account deletion or privilege escalation is the highest-severity defect class available in this surface | Exploratory |
| R2 | **Privilege boundaries on `/produtos` and `/carrinhos`** â€” can a non-admin write? | Classic broken-access-control; spec says admin-only, so any gap is a real bug | Exploratory |
| R3 | **`administrador` is a string, not a boolean** | Type looseness at a privilege boundary. Probe `"TRUE"`, `true`, `1`, `"yes"` â€” coercion bugs here are privilege escalation | Exploratory |
| R4 | **Cart invariants** â€” one cart per user, stock returned on cancel but not on conclude | Stateful rules are where real logic bugs live; also the only multi-step business flow in the app | Strategy â†’ Automation |
| R5 | **Input validation across all write ops** â€” boundaries, empty, oversized, wrong type, injection-shaped strings | Broad, mechanical, high-yield | Strategy |
| R6 | **Token handling** â€” absent, malformed, expired, another user's, admin-vs-user | Directly testable and the 600s expiry gives us a real expired token for free | Automation |
| R7 | **Duplicate-email handling on register and update** | Uniqueness constraints are commonly enforced on create but forgotten on update | Exploratory |
| R8 | **Search/filter behaviour on list endpoints** | Lower severity, but unvalidated query params are a common injection surface | Strategy |

Hypotheses to confirm, not assert â€” the team verifies these against the live app before any of it reaches a bug report:
duplicate email rejected on `POST /usuarios`; second cart per user rejected; non-admin product write rejected; deleting a user who owns a cart rejected; missing token yields 401 rather than 500.

---

## 4. Approach

**Four workstreams, deliberately overlapping.** The old sequencing had exploratory testing waiting on the risk register; that ordering is wrong for this target. The surface is fully enumerable from the spec, so exploratory work can start immediately and in parallel â€” and it should, because we want real bugs found *before* automation hardcodes wrong assumptions about correct behaviour.

```
Now â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–º

TES-4  Inventory + risk register   â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆ
TES-6  Exploratory pass            â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆ
TES-7  Playwright scaffold         â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆ
TES-5  Strategy + coverage map             â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆ
TES-8  Automate critical flows                 â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆ
TES-9  CI                                              â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆ   (needs your answer)
```

### Layers

- **API functional** â€” every one of the 16 operations, happy path plus negative. This is the backbone and it is finite: full coverage is the target, and we will report against it as a checklist.
- **Contract** â€” responses validated against `swagger.json` shapes. Cheap to add once, catches drift no hand-written assertion will.
- **Exploratory** â€” charter-driven sessions against the R1â€“R8 register. Bugs come from here first.
- **UI/E2E** â€” the critical journeys through `front.serverest.dev` with origin rewriting: register â†’ login â†’ create product â†’ add to cart â†’ complete purchase.
- **Regression** â€” the accumulated suite, green in CI on every run, which is the actual long-term deliverable.

### Out of scope

Load and performance testing, security penetration beyond authorisation-boundary probing, and any destructive testing against the shared instance. This is a shared sandbox â€” we test it, we do not stress it. Say the word if you want any of these added and we will scope them separately.

---

## 5. Testware to be produced

| Artifact | Where it lands | Owner |
|---|---|---|
| Surface inventory + risk register | TES-4, document `inventory` | QA Strategy Lead |
| Test strategy + coverage map (16 ops Ã— cases) | TES-5, document `strategy` | QA Strategy Lead |
| Session charters + exploratory findings | TES-6, document `findings` | Exploratory Tester |
| Playwright framework scaffold | Workspace repo | Automation Engineer |
| Automated suite â€” API, contract, E2E | Workspace repo | Automation Engineer |
| CI pipeline + reporting | TES-9 | CI Engineer |
| Bug reports | One issue per defect, label `bug` | Whoever finds it |

### Bug reporting standard

One issue per defect. Title states the defect, not the activity. Body carries: exact request (method, path, headers, body), actual response (status + payload), expected response with the reasoning for that expectation, severity, and a runnable `curl` reproduction. A bug without a reproduction command does not get filed.

---

## 6. Definition of done

1. All 16 operations covered by automated tests, happy path and negative.
2. The five critical journeys automated end-to-end and passing.
3. Suite runs green, repeatably, with no flake across three consecutive runs.
4. Every confirmed defect filed with a runnable reproduction.
5. Suite wired into CI and gating â€” *this one depends on your answer below.*
6. Coverage map published showing what is tested and what is deliberately not.

---

## 7. What I need from you

Exactly one thing, and it only gates item 5 above. Everything else is running now.

**Where should the test suite live, and what CI runs it?** There is no repository configured for this company and no push credential on this machine. Without a repo the suite cannot gate a change; it will still exist and run locally, but "green in CI" is undeliverable. Cloud-hosted runners are fine â€” the target is publicly reachable, so no self-hosted runner is needed.

A card with this question is on TES-10. If the answer is "no repo yet", say so plainly and we will deliver the suite as a self-contained local project and revisit CI later â€” that is a perfectly reasonable outcome, and better decided now than in week two.
