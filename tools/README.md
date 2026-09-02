# Test infrastructure tooling

Built for TES-3 (Access & environment readiness). No dependencies beyond Node >= 18.

## `staging-readiness-probe.mjs`

Answers one question with numbers instead of opinion: **is this environment reachable
and stable enough to hang a Playwright suite off?**

Run it the moment a staging URL lands, before anyone writes a test against it. Run it
again as a CI pre-flight step, so an environment outage is reported as an environment
outage rather than as fifty failing tests.

```bash
node tools/staging-readiness-probe.mjs --url https://staging.example.com
node tools/staging-readiness-probe.mjs \
  --url https://staging.example.com \
  --api https://staging-api.example.com/health \
  --samples 20 --interval 3000 --json readiness.json
```

### What it checks

| Check | Why it matters for the suite |
|---|---|
| DNS resolution + timing | Separates "wrong hostname" from "app is down" |
| Redirect chain | A bounce to an SSO host tells you which credentials you actually need |
| TLS cert, issuer, expiry | An expiry mid-engagement is a self-inflicted outage |
| TLS interception detection | Corporate proxies re-sign traffic and break browser trust stores |
| Final status + content type | Distinguishes "reachable" from "serving the app under test" |
| Auth / WAF / bot gates | 401, 403, 503, Cloudflare challenge — reachable but untestable |
| Placeholder page detection | Default nginx page means the app is not deployed there |
| Latency p50 / p95 / max, TTFB vs total | Sets whether default Playwright timeouts will hold |
| Jitter (p95 ÷ p50) | Spiky latency is the usual root cause of "flaky" UI tests |
| Error rate across N samples | One fast response proves nothing; stability is the question |

### Exit codes — usable as a CI gate

| Code | Verdict | Meaning |
|---|---|---|
| 0 | `READY` | Safe to point the suite at it |
| 1 | `DEGRADED` | Runnable, but expect flake; findings explain why |
| 2 | `NOT_READY` | Environment is the problem; do not run the suite |
| 3 | — | Usage error, or the production guard refused |

### Production guard

The engagement rule is *never test against production without explicit written
approval*, so the probe enforces it rather than trusting anyone to remember. It refuses
any hostname that carries no non-production marker (`staging`, `stage`, `qa`, `uat`,
`dev`, `preview`, `sandbox`, ...).

Overriding is deliberately awkward and leaves a record in the output:

```bash
--allow-prod --approval "approved by <name>, <date>, <where it is written down>"
```

### Secret hygiene

The output is designed to be pasted into an issue comment. It prints cookie **names**
only, never values, and never echoes the `--header` values you pass it.

---

## Runner note: TLS interception (verified 2026-09-01)

This machine sits behind a **Zscaler** TLS-inspecting proxy. Node does not trust the
re-signed certificates out of the box, and this breaks Playwright setup hard:

```
npx playwright install
  → Error: UNABLE_TO_GET_ISSUER_CERT_LOCALLY
  → Failed to install browsers
```

**Fix — required on any runner behind this proxy:**

```bash
export NODE_OPTIONS=--use-system-ca      # Node >= 22
# or, if the Zscaler root is exported to a file:
export NODE_EXTRA_CA_CERTS=/path/to/zscaler-root.pem
```

Verified working with that set:

| Component | Result |
|---|---|
| `npx playwright install chromium firefox` | downloads succeed |
| Chromium 151 — launch, HTTPS navigation, DOM interaction | OK |
| Firefox 153 — launch, HTTPS navigation | OK |
| WebKit | not yet verified |

This matters for CI: a **self-hosted** runner behind the same proxy needs the variable
set at the runner level. A **cloud-hosted** runner (GitHub-hosted, etc.) is not affected
— but it will need network access to the staging environment, which an IP allowlist may
not grant. That tension gets decided in TES-9.
