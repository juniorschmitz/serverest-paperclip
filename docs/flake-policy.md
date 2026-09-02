# Flake policy

**The rule this whole document exists to protect: red means broken.**

If a red run can mean "run it again", the suite has stopped being a gate and
become a suggestion. Everything below is machinery in service of keeping that
one sentence true.

Owner: Test Infrastructure & CI Engineer. Issue: TES-9.

---

## 1. No retries. Anywhere.

`playwright.config.ts` sets `retries: 0`, and every CI invocation passes
`--retries=0` on the command line as well, so the gate does not depend on the
config file staying correct.

This is deliberate and it is not negotiable by convenience:

- A retry turns a real intermittent defect into a green run. The information is
  destroyed at exactly the moment it was available.
- "Flaky" is not a property of a test. It is a defect in the test, the app, or
  the environment. Retrying it picks none of those and hides all three.
- A suite that retries teaches everyone to re-run rather than read. After that,
  a genuine regression is indistinguishable from noise.

`scripts/ci-health.mjs` reports the count of Playwright `flaky` outcomes on
every run. Because retries are off, that number **must** be 0. If it is ever
non-zero, retries leaked in somewhere and the summary says so in bold — the
number is a tripwire on the policy itself, not a statistic.

## 2. Detection is a separate job, not a retry

The gate cannot detect flake — with retries off, a flaky test is just red, and
red is indistinguishable from a real break. Detection therefore happens off the
gating path:

| | Question | Tool | When |
| --- | --- | --- | --- |
| Before a test is committed | "Is this test ready to ship?" | `npm run reliability` — N consecutive whole-suite runs, red if any run is red | Local, by the test author |
| Continuously, after it ships | "Which test is unstable?" | `scripts/flake-scan.mjs` — per-test pass rate across N runs | Nightly, `.github/workflows/flake-scan.yml`, 04:00 UTC |

`flake-scan.mjs` classifies every test it observes:

- **stable-pass** — 100% across all runs. Nothing to do.
- **FLAKY** — passed sometimes, failed sometimes. This is the flake list.
- **consistent-fail** — failed in *every* run. **Not a flake.** A broken test or
  a real product bug. Never quarantine these; fix or file them.
- **never-ran / missing from some runs** — skipped everywhere, or absent from
  some runs (worker crash, changed shard boundary). Surfaced rather than hidden,
  because a test that silently stops running is worse than one that fails.

The distinction between FLAKY and consistent-fail is the point. Quarantine is
for non-determinism only. A test that always fails is telling you something true.

## 3. Triage: one working day

A test on the flake list gets a decision within one working day. Three outcomes,
and only three:

1. **Fix it.** Preferred, and usually cheap. The recurring causes here are
   ordered by how often they are the answer: a wait on a timeout instead of on
   state; an assertion on data another test can touch; a shared token or
   identity; a real race in the app.
2. **Quarantine it** — only if the cause is not yet understood *and* the test is
   blocking others. Section 4. This is a loan, not a resolution.
3. **Reject the flake classification** — it is a real product bug that happens to
   be intermittent. File it as a bug and keep the test red. An intermittent
   product defect is a product defect; making the test green would be hiding it.

Doing nothing is not on the list. An untriaged flake list is how a suite dies:
each individual red run gets re-run, and eventually nobody reads any of them.

## 4. Quarantine: explicit, visible, and expiring

Quarantine is the **only** sanctioned way to stop a test gating changes.
Deleting it, skipping it, `test.fixme`-ing it, or wrapping it in a retry are not
alternatives — they are the same act with no audit trail.

To quarantine, in **one commit**:

1. Tag the test `@quarantine` in its spec.
2. Add a row to [`docs/quarantine.md`](./quarantine.md) with all seven fields:
   test, project, quarantined date, review-by date, **a named owner** (not a
   team), a tracking issue, and the reason.
3. Reference the tracking issue in the row.

What the machinery then does, on every single run:

- The gate runs `--grep-invert='@quarantine'`, so a quarantined test cannot make
  the build red.
- A separate **non-blocking** `quarantined` job runs those tests anyway and
  publishes their results to the run summary. A quarantined test is not a hidden
  test — if it starts passing consistently, the summary says so and tells you to
  take it back out.
- `scripts/quarantine-audit.mjs` runs in the gating `setup` job and **fails the
  build** if:
  - the number of `@quarantine` tags in code does not match the number of rows
    in the list (this is the important one — it makes it impossible for a test to
    drop out of the gate without a visible entry),
  - any field is empty, or the owner is a team rather than a person,
  - a review window exceeds **14 days**,
  - an entry is **past its review-by date**,
  - more than **max(5, 2% of the suite)** tests are quarantined at once.

The expiry is the part that matters. Without it, quarantine is a graveyard with
extra steps. Past the review date the build goes red, and the fix is to resolve
the test — **not** to extend the date. Extending requires a written reason in the
row and Chief of Staff sign-off.

The cap exists because past some number of excluded tests the gate is not
meaningfully gating, and it is more honest to admit that loudly than to keep
adding rows.

## 5. Leaving quarantine

1. Fix the cause.
2. `npm run reliability -- 10` (or `node scripts/flake-scan.mjs --repeats 10 --grep '<title>'`).
3. Confirm 100%.
4. Drop the `@quarantine` tag and delete the row, in one commit.

## 6. What gets reported, and where

| Signal | Where | Every |
| --- | --- | --- |
| Pass rate, runtime, failure list, slowest tests | Run summary, via `ci-health.mjs` | Run |
| `ci-health.json` (machine-readable trend data, 90d) | Run artifact | Run |
| Quarantine list + how those tests did | Run summary | Run |
| Per-test flake pass rates | Flake-scan summary + artifact (90d) | Night |
| Failure notification | GitHub email to the author; Slack if `SLACK_WEBHOOK_URL` is set | On failure |

Retention is deliberate: reports live 30 days, raw failure artifacts 14, and the
health/flake JSON 90 — the numbers outlive the reports they came from, because
the trend is what tells you the suite is degrading before anyone complains.

## 7. Honest limits of this policy

- **A flake scan of N runs finds flakes with a failure rate above roughly 1/N.**
  Five nightly runs will not find a 1-in-50 flake; it will show up as an
  unexplained red run first. That is a known gap, not an oversight — raise
  `--repeats` for a suspect area rather than assuming the suite is clean.
- **The scan runs against a shared public sandbox.** Interference from other
  users of that sandbox is indistinguishable from our own non-determinism. A
  flake that only ever appears in the nightly scan and never in the gate should
  be checked against that before a test is blamed.
- **`consistent-fail` classification depends on the environment being up.** If
  the target is down, every test is a consistent-fail and none of them are bugs.
  Check the readiness probe before triaging a mass failure.
