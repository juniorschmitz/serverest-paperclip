# CI pipeline

GitHub Actions. Repository: `github.com/juniorschmitz/serverest-paperclip`.
Owner: Test Infrastructure & CI Engineer (TES-9).

## The two workflows

| Workflow | Trigger | Gates a change? | Purpose |
| --- | --- | --- | --- |
| [`tests.yml`](../.github/workflows/tests.yml) | every push; fork PRs | **Yes** | Run the suite, report, gate |
| [`flake-scan.yml`](../.github/workflows/flake-scan.yml) | nightly 04:00 UTC; manual | No | Per-test stability, see [flake policy](./flake-policy.md) |

### Exactly one run per change

`push` covers branches in this repo; `pull_request` covers forks. The `setup`
job carries:

```yaml
if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name != github.repository
```

so a same-repo PR does not run the suite twice. `concurrency` with
`cancel-in-progress: true` means a new push supersedes an in-flight run on the
same ref, rather than queueing behind it.

### Job graph

```
setup ─┬─> api (API_SHARDS) ─┬─> report        <-- the required check
       └─> ui  (UI_SHARDS)  ─┴─> quarantined   (non-blocking, off the gate path)
```

`report` is the job to mark as the required status check in branch protection.
It runs even when shards fail — a failed run is exactly when the report matters
— and re-asserts failure at the end via its `Gate` step, so the check cannot go
green while a shard was red.

`setup` fails fast on the cheap things before six jobs spend runner minutes:
typecheck, a committed-`.env` guard, a `.only` guard, and the quarantine audit.

## Runtime

The design targets **under 10 minutes wall clock**, because a gate slower than
that is a gate people route around.

| Lever | Setting | Why |
| --- | --- | --- |
| API browser install | none | The `api` project uses Playwright's request context, no browser. Skipping the download is the single biggest saving. |
| Browser cache | `~/.cache/ms-playwright`, keyed on the exact `@playwright/test` version from `package-lock.json` | Full download only when the pinned version changes; otherwise just `install-deps`. |
| npm cache | `actions/setup-node` with `cache: npm` | Restores the npm cache; `npm ci` still installs from the lockfile. |
| Sharding | `API_SHARDS`, `UI_SHARDS` | Wall clock is the slowest shard, not the sum. |
| Workers | `API_WORKERS`, `UI_WORKERS` | A 4-vCPU runner cannot honestly run 4 Chromium instances; oversubscription shows up as timeout flake. |
| Fast fail | `setup` gates the test jobs | A typecheck error costs one minute, not every test job. |
| Timeouts | per job, 10–25 min | Bounds a hang to minutes instead of GitHub's 6-hour default. |

All four tuning values are `env:` entries at the top of `tests.yml` — one place,
not scattered through the jobs. `setup` expands the shard counts into the job
matrices, so the shard total exists as a single number. That matters: hand-written
`matrix.shard: [1, 2]` alongside `--shard=x/2` is two numbers that can disagree,
and when they disagree tests are silently **not run** rather than run twice.
Bad values (`0`, empty, non-numeric) fail `setup` with an explicit error.

### Concurrency budget against the target — the binding constraint

`docs/shared-sandbox-rules.md` caps parallelism at **4 workers**:
`compassuol.serverest.dev` is a shared public sandbox nobody pays for, and "we
test it; we do not hammer it" is an engagement rule.

Total concurrent clients = `(API_SHARDS x API_WORKERS) + (UI_SHARDS x UI_WORKERS)`.

Current setting is `1x2 + 1x2 = 4` — exactly at the cap. **This, not runner
capacity, is what currently limits shard count.** Raising either value is a load
decision about someone else's free service as much as a speed decision, and past
some point the interference registers as our own flake.

Consequence worth being explicit about: with the cap binding, the suite is not
sharded today (1 shard per project). The sharding *mechanism* is in place and
costs one number to scale, but scaling it needs either a decision to accept more
sandbox load, or a dedicated instance. Flag it when a single shard approaches
~5 minutes; `ci-health.json` carries wall clock and the slowest 10 tests on
every run, which is the cheapest way to know.

The `quarantined` job runs *after* `api`/`ui` rather than alongside them, so it
never spends the budget while the gate is using it.

## Secrets

**The suite needs no target credentials.** Tests self-seed their own accounts
against a public self-serve sandbox, so there is nothing to store. That is the
strongest possible answer to "secret management" and it is worth keeping true.

| Name | Kind | Required | Purpose |
| --- | --- | --- | --- |
| `SLACK_WEBHOOK_URL` | secret | No | Failure + flake notifications. Absent ⇒ the step is skipped, not failed. |
| `API_BASE_URL` | **variable** | No | Point at another environment without a code change. |
| `UI_BASE_URL` | **variable** | No | As above. |

Base URLs are repo *variables*, not secrets: a public sandbox URL is not a
credential, and storing it as a secret only makes logs harder to read.

Rules enforced, not just documented:

- `.env` is gitignored, and `setup` **fails the build** if any `.env` file is
  ever tracked (`.env.example` is exempt and contains no secrets).
- Nothing is echoed to logs. `notify-slack.mjs` reads the webhook from the
  environment and never prints it.
- `permissions: contents: read` on both workflows — the pipeline can read the
  repo and nothing else. No token is handed to test code.

`NODE_EXTRA_CA_CERTS` in a local `.env` is a machine-local artifact of the
corporate TLS-inspecting proxy on the authoring machine. **CI needs no CA
config** — GitHub runners reach the sandbox directly. A local
`unable to get local issuer certificate` failure is a proxy artifact, not a
suite defect and not a CI defect.

## Failure artifacts

Aim: from a red run to a root cause in about two minutes.

| Artifact | Retention | Contents |
| --- | --- | --- |
| `playwright-report` | 30 days | Merged HTML report, all shards, **traces embedded**. Download, open `index.html`, click the failed test. |
| `failure-artifacts-ui-<shard>` | 14 days | Raw `test-results/` — trace zips, video, screenshots — for when the files are wanted directly. |
| `ci-health` | 90 days | `ci-health.json`: pass rate, runtime, failures, slowest tests. Trend data. |
| `blob-*` | 1 day | Intermediate per-shard blobs. Inputs to the merge; not for humans. |
| `flake-scan-report` | 90 days | Per-run JSON plus the flake summary. |

`trace: 'retain-on-failure'` in the Playwright config is what makes this work.
With `retries: 0`, the more common `on-first-retry` would capture **nothing,
ever** — there is no first retry. Do not change one without the other.

To replay a trace locally:

```bash
npx playwright show-trace <path-to>/trace.zip
```

## Reporting

- **Run summary** — `ci-health.mjs` writes a markdown table (pass rate, runtime,
  failure list with `file:line`, flake count, slowest 10) to
  `$GITHUB_STEP_SUMMARY`. Visible without downloading anything.
- **Inline annotations** — the merged report includes Playwright's `github`
  reporter, so failures annotate the offending line in the diff.
- **Quarantine status** — published to the summary on every run, so an excluded
  test is never a silent one.
- **Notification** — GitHub emails the pushing author on failure with no
  configuration. Slack additionally, if `SLACK_WEBHOOK_URL` is set. The notifier
  is deliberately incapable of failing a build: an unreachable webhook logs and
  exits 0, because a broken notifier must never turn a green run red.

## Local equivalents

Everything CI runs, runnable by hand:

```bash
npm ci
npm run typecheck
node scripts/quarantine-audit.mjs                    # the quarantine gate
npx playwright test --retries=0 --grep-invert='@quarantine'
node scripts/flake-scan.mjs --repeats 5              # per-test flake attribution
npm run reliability -- 10                            # ship-readiness bar for a new test
```

## Verification status

The pipeline configuration is complete and its components are verified locally:
workflow YAML structure and `needs`/matrix references, the
blob → `merge-reports` → HTML/annotations/JSON chain against a real Playwright
run, `ci-health.mjs` against that real merged report, all six quarantine-audit
enforcement paths, and both notifier failure modes.

**Not yet verified: an actual run on GitHub Actions.** That requires push access
to the repository, which this machine does not have. Until then, treat runner
behaviour (cache hit rates, real wall clock, annotation rendering) as designed
rather than measured. See TES-9 for the blocker.
