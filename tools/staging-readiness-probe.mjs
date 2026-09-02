#!/usr/bin/env node
// Staging readiness probe — TES-3.
//
// Answers one question with numbers instead of opinion: is this environment
// reachable and stable enough to hang a Playwright suite off?
//
// No dependencies. Node >= 18.
//
//   node tools/staging-readiness-probe.mjs --url https://staging.example.com
//   node tools/staging-readiness-probe.mjs --url https://staging.example.com \
//        --api https://staging-api.example.com/health --samples 20 --interval 3000
//
// Exit codes are meant to be used as a CI pre-flight gate:
//   0 READY       run the suite
//   1 DEGRADED    runnable, but expect flake; see reasons
//   2 NOT_READY   do not run the suite; the environment is the problem
//   3 usage/config error (including the production guard)

import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------- thresholds
// Tuned for "can a browser test run against this", not for SLO reporting.
const T = {
  p95WarnMs: 2000,        // above this, UI tests start needing longer waits
  p95FailMs: 8000,        // above this, default Playwright timeouts will bite
  jitterWarnRatio: 3,     // p95 / p50 — spiky is worse than uniformly slow
  errorWarnPct: 1,        // any error at all is worth naming
  errorFailPct: 10,
  certWarnDays: 21,       // an expiry mid-engagement is a self-inflicted outage
};

// TLS verification failures. These mean "we reached the server but could not
// trust it" — a different diagnosis from "we could not reach the server", and
// worth separating because corporate TLS interception produces the former
// constantly while the environment itself is perfectly healthy.
const TLS_TRUST_ERRORS = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_UNTRUSTED', 'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_SIGNATURE_FAILURE',
]);

// Issuer organisations that mean a middlebox re-signed the certificate. When
// one of these shows up, the cert you are inspecting is the proxy's, not the
// origin's — so its expiry date tells you nothing about the real environment.
const INTERCEPTION_ISSUERS = [
  'zscaler', 'netskope', 'blue coat', 'bluecoat', 'broadcom', 'forcepoint',
  'palo alto', 'fortinet', 'fortigate', 'mcafee', 'cisco umbrella', 'sophos',
  'check point', 'menlo security', 'iboss', 'symantec web', 'trend micro',
];

// Hostname tokens that mark an environment as safely non-production.
// The engagement rule is "never test against production without written
// approval", so the default is to refuse anything that doesn't look non-prod.
const NON_PROD_TOKENS = [
  'staging', 'stage', 'stg', 'test', 'tst', 'dev', 'develop', 'qa', 'uat',
  'preview', 'preprod', 'pre-prod', 'sandbox', 'demo', 'localhost', '127.0.0.1',
];

// ---------------------------------------------------------------- arg parsing
function parseArgs(argv) {
  const out = {
    url: null, api: null, samples: 10, interval: 2000, timeout: 20000,
    json: null, allowProd: false, approval: null, header: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--url': out.url = next(); break;
      case '--api': out.api = next(); break;
      case '--samples': out.samples = Number(next()); break;
      case '--interval': out.interval = Number(next()); break;
      case '--timeout': out.timeout = Number(next()); break;
      case '--json': out.json = next(); break;
      case '--allow-prod': out.allowProd = true; break;
      case '--approval': out.approval = next(); break;
      case '--header': out.header.push(next()); break;
      case '-h': case '--help': out.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
    }
  }
  return out;
}

const USAGE = `
staging-readiness-probe — is this environment stable enough to test against?

  --url <url>          Required. The staging web app entry point.
  --api <url>          Optional. API base or health endpoint, probed alongside.
  --samples <n>        Timing samples per target (default 10).
  --interval <ms>      Delay between samples (default 2000).
  --timeout <ms>       Per-request timeout (default 20000).
  --header "K: V"      Extra request header; repeatable (e.g. basic-auth gate).
  --json <path>        Write the full result object to a file.
  --allow-prod         Probe a host that does not look non-production.
                       Requires --approval "<who approved, when, where>".
  --approval <text>    Written-approval reference recorded in the output.

Exit: 0 READY  1 DEGRADED  2 NOT_READY  3 usage/guard error
`.trim();

// ---------------------------------------------------------------- prod guard
function looksNonProd(hostname) {
  const h = hostname.toLowerCase();
  return NON_PROD_TOKENS.some((t) => h.split(/[.\-_]/).includes(t) || h.includes(t));
}

function assertNotProduction(targets, opts) {
  const suspect = targets.filter((t) => !looksNonProd(new URL(t.url).hostname));
  if (suspect.length === 0) return null;
  const names = suspect.map((t) => new URL(t.url).hostname).join(', ');
  if (!opts.allowProd) {
    throw Object.assign(
      new Error(
        `Refusing to probe ${names}: hostname carries no non-production marker ` +
        `(${NON_PROD_TOKENS.slice(0, 8).join(', ')}, ...).\n` +
        `If this really is a test environment, re-run with:\n` +
        `  --allow-prod --approval "approved by <name>, <date>, <where it is written down>"`
      ),
      { code: 'PROD_GUARD' }
    );
  }
  if (!opts.approval) {
    throw Object.assign(
      new Error('--allow-prod requires --approval "<who approved, when, where>".'),
      { code: 'PROD_GUARD' }
    );
  }
  return { hosts: names, approval: opts.approval };
}

// ---------------------------------------------------------------- primitives
function parseHeaders(list) {
  const h = {};
  for (const raw of list) {
    const idx = raw.indexOf(':');
    if (idx === -1) throw new Error(`Bad --header "${raw}" (expected "Key: Value")`);
    h[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  }
  return h;
}

async function resolveDns(hostname) {
  const started = process.hrtime.bigint();
  try {
    const { address, family } = await lookup(hostname);
    return { ok: true, address, family, ms: msSince(started) };
  } catch (err) {
    return { ok: false, error: err.code || err.message, ms: msSince(started) };
  }
}

function msSince(startedNs) {
  return Number(process.hrtime.bigint() - startedNs) / 1e6;
}

// One HTTP request. Records TTFB separately from total, because a fast TTFB
// with a slow body reads very differently in a browser test than the reverse.
function fetchOnce(url, { timeout, headers, collectBody = false, insecure = false }) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, error: 'INVALID_URL' }); }
    const isHttps = u.protocol === 'https:';
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { 'user-agent': 'testing-cia-readiness-probe/1.0', ...headers },
        timeout,
        ...(insecure ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const ttfbMs = msSince(started);
        let bytes = 0;
        const chunks = [];
        res.on('data', (c) => {
          bytes += c.length;
          if (collectBody && bytes <= 64 * 1024) chunks.push(c);
        });
        res.on('end', () => {
          resolve({
            ok: true,
            status: res.statusCode,
            headers: res.headers,
            ttfbMs,
            totalMs: msSince(started),
            bytes,
            tls: isHttps ? readCert(req) : null,
            body: collectBody ? Buffer.concat(chunks).toString('utf8') : null,
          });
        });
      }
    );
    const started = process.hrtime.bigint();
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    req.on('error', (err) => {
      resolve({ ok: false, error: err.code || err.message, totalMs: msSince(started) });
    });
    req.end();
  });
}

function readCert(req) {
  try {
    const sock = req.socket;
    if (!sock || typeof sock.getPeerCertificate !== 'function') return null;
    const c = sock.getPeerCertificate();
    if (!c || !c.valid_to) return null;
    const validTo = new Date(c.valid_to);
    return {
      subject: c.subject?.CN ?? null,
      issuer: c.issuer?.O ?? c.issuer?.CN ?? null,
      validFrom: c.valid_from,
      validTo: c.valid_to,
      daysRemaining: Math.floor((validTo.getTime() - Date.now()) / 86400000),
      authorized: sock.authorized === true,
      authorizationError: sock.authorizationError ? String(sock.authorizationError) : null,
      intercepted: isInterceptionIssuer(c.issuer),
    };
  } catch { return null; }
}

function isInterceptionIssuer(issuer) {
  const who = `${issuer?.O ?? ''} ${issuer?.CN ?? ''}`.toLowerCase();
  return INTERCEPTION_ISSUERS.find((v) => who.includes(v)) ?? null;
}

// Follow redirects by hand so the chain itself becomes evidence — a staging URL
// that bounces to a login SSO host tells you what credentials you actually need.
async function fetchFollowing(url, opts, max = 5) {
  const chain = [];
  let current = url;
  for (let i = 0; i <= max; i++) {
    const res = await fetchOnce(current, { ...opts, collectBody: i === max || undefined });
    if (!res.ok) return { chain, final: res, finalUrl: current };
    chain.push({ url: current, status: res.status, location: res.headers.location ?? null });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    return { chain, final: res, finalUrl: current };
  }
  return { chain, final: { ok: false, error: 'TOO_MANY_REDIRECTS' }, finalUrl: current };
}

// ---------------------------------------------------------------- statistics
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length;
  return {
    n: s.length,
    minMs: round(s[0]),
    p50Ms: round(percentile(s, 50)),
    p95Ms: round(percentile(s, 95)),
    maxMs: round(s[s.length - 1]),
    meanMs: round(mean),
    stdDevMs: round(Math.sqrt(variance)),
  };
}

const round = (n) => (n == null ? null : Math.round(n * 10) / 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- gate checks
// Things that mean "you can reach it but you still cannot test it".
function detectGates(final) {
  const gates = [];
  if (!final.ok) return gates;
  const h = final.headers ?? {};
  const body = final.body ?? '';

  if (final.status === 401) {
    gates.push({
      kind: 'http_auth',
      detail: h['www-authenticate'] ?? 'no www-authenticate header',
      note: 'Needs credentials before any test can load a page.',
    });
  }
  if (final.status === 403) {
    gates.push({ kind: 'forbidden', detail: `HTTP 403`, note: 'IP allowlist or WAF is likely blocking the runner.' });
  }
  if (final.status === 503) {
    gates.push({ kind: 'unavailable', detail: `HTTP 503`, note: h['retry-after'] ? `retry-after: ${h['retry-after']}` : 'Environment may be asleep or deploying.' });
  }
  if (h['cf-mitigated'] || /cf-browser-verification|challenge-platform|__cf_chl/i.test(body)) {
    gates.push({ kind: 'bot_challenge', detail: 'Cloudflare challenge', note: 'Headless browsers will be blocked; needs a bypass token or allowlist.' });
  }
  if (/<title>\s*(welcome to nginx|apache2 .* default page|it works!)/i.test(body)) {
    gates.push({ kind: 'placeholder', detail: 'Default web-server page', note: 'The host answers but the app is not deployed here.' });
  }
  if (/under construction|coming soon|maintenance mode/i.test(body) && body.length < 8000) {
    gates.push({ kind: 'placeholder', detail: 'Maintenance/placeholder page', note: 'Not the application under test.' });
  }
  return gates;
}

function extractTitle(body) {
  const m = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(body ?? '');
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

// Header names only — never values. Cookie values and auth headers are secrets
// and this output gets pasted into issue comments.
function cookieNames(setCookie) {
  if (!setCookie) return [];
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list.map((c) => String(c).split('=')[0].trim());
}

// ---------------------------------------------------------------- probe a target
async function probeTarget(name, url, opts) {
  const headers = parseHeaders(opts.header);
  const hostname = new URL(url).hostname;

  const dns = await resolveDns(hostname);
  if (!dns.ok) {
    return {
      name, url, dns, verdict: 'NOT_READY',
      reasons: [`DNS lookup for ${hostname} failed (${dns.error}). Nothing else can be checked.`],
    };
  }

  // First pass: shape of the response, redirect chain, TLS, gates.
  let insecure = false;
  let trustFailure = null;
  let first = await fetchFollowing(url, { timeout: opts.timeout, headers });

  // A TLS trust failure is not the same as an unreachable host. Retry without
  // verification so we can still gather evidence and say precisely what is
  // wrong — self-signed staging cert, or a corporate proxy re-signing traffic.
  if (!first.final.ok && TLS_TRUST_ERRORS.has(first.final.error)) {
    trustFailure = first.final.error;
    insecure = true;
    first = await fetchFollowing(url, { timeout: opts.timeout, headers, insecure });
  }

  if (!first.final.ok) {
    const isTls = TLS_TRUST_ERRORS.has(first.final.error) || /^ERR_TLS|^ERR_SSL/.test(String(first.final.error));
    return {
      name, url, dns, redirectChain: first.chain, verdict: 'NOT_READY',
      reasons: [
        isTls
          ? `TLS handshake failed (${first.final.error}). Host resolves to ${dns.address} and accepts connections, but the certificate could not be negotiated.`
          : `Request failed: ${first.final.error}. Host resolves to ${dns.address} but did not return an HTTP response.`,
      ],
    };
  }

  const withBody = await fetchOnce(first.finalUrl, { timeout: opts.timeout, headers, collectBody: true, insecure });
  const final = withBody.ok ? { ...first.final, ...withBody } : first.final;
  const gates = detectGates(final);

  // Second pass: stability. One fast response proves nothing; the question is
  // whether it is fast every time.
  const ttfb = [];
  const total = [];
  const statuses = new Map();
  let errors = 0;
  const errorKinds = new Map();

  for (let i = 0; i < opts.samples; i++) {
    if (i > 0) await sleep(opts.interval);
    const s = await fetchOnce(first.finalUrl, { timeout: opts.timeout, headers, insecure });
    if (!s.ok) {
      errors++;
      errorKinds.set(s.error, (errorKinds.get(s.error) ?? 0) + 1);
      continue;
    }
    ttfb.push(s.ttfbMs);
    total.push(s.totalMs);
    statuses.set(s.status, (statuses.get(s.status) ?? 0) + 1);
  }

  const errorPct = (errors / opts.samples) * 100;
  const ttfbStats = summarize(ttfb);
  const totalStats = summarize(total);

  // ---- verdict
  const reasons = [];
  let verdict = 'READY';
  const fail = (r) => { reasons.push(r); verdict = 'NOT_READY'; };
  const warn = (r) => { reasons.push(r); if (verdict === 'READY') verdict = 'DEGRADED'; };

  if (errorPct >= T.errorFailPct) {
    fail(`${errors}/${opts.samples} samples failed (${round(errorPct)}%): ${[...errorKinds].map(([k, v]) => `${k}×${v}`).join(', ')}.`);
  } else if (errors > 0) {
    warn(`${errors}/${opts.samples} samples failed (${round(errorPct)}%): ${[...errorKinds].map(([k, v]) => `${k}×${v}`).join(', ')}.`);
  }

  if (statuses.size > 1) {
    warn(`Inconsistent status codes across samples: ${[...statuses].map(([k, v]) => `${k}×${v}`).join(', ')}.`);
  }

  const blocking = gates.filter((g) => g.kind !== 'placeholder' || true);
  for (const g of blocking) {
    if (g.kind === 'placeholder' || g.kind === 'bot_challenge' || g.kind === 'forbidden') fail(`${g.detail} — ${g.note}`);
    else warn(`${g.detail} — ${g.note}`);
  }

  if (final.status >= 500) fail(`Final status ${final.status}: the app is erroring, not just slow.`);
  else if (final.status >= 400 && final.status !== 401) warn(`Final status ${final.status}.`);

  if (totalStats) {
    if (totalStats.p95Ms >= T.p95FailMs) fail(`p95 response ${totalStats.p95Ms}ms exceeds ${T.p95FailMs}ms — default Playwright timeouts will fail on load alone.`);
    else if (totalStats.p95Ms >= T.p95WarnMs) warn(`p95 response ${totalStats.p95Ms}ms — slow enough to need raised timeouts.`);

    if (totalStats.p50Ms > 0 && totalStats.p95Ms / totalStats.p50Ms >= T.jitterWarnRatio) {
      warn(`Jitter: p95 (${totalStats.p95Ms}ms) is ${round(totalStats.p95Ms / totalStats.p50Ms)}× p50 (${totalStats.p50Ms}ms). Spiky latency is the usual root of "flaky" UI tests.`);
    }
  }

  const tls = final.tls;
  if (tls) {
    if (tls.intercepted) {
      // The runner is behind a TLS-inspecting proxy. This is a runner problem,
      // not an environment problem, and it will hit Playwright's browsers too.
      warn(
        `TLS is being intercepted by ${tls.intercepted} (cert re-issued by "${tls.issuer}"). ` +
        `The certificate seen here is the proxy's, not the origin's, so its ${tls.daysRemaining}-day expiry says nothing about staging. ` +
        `Node needs --use-system-ca or NODE_EXTRA_CA_CERTS, and Playwright's bundled browsers need the same root installed.`
      );
    } else if (trustFailure) {
      fail(
        `TLS certificate not trusted (${trustFailure}), issued by "${tls.issuer ?? 'unknown'}". ` +
        `Either install the issuing root on the runner, or the suite must set ignoreHTTPSErrors — which hides real certificate problems.`
      );
    } else if (tls.authorized === false) {
      fail(`TLS certificate not trusted: ${tls.authorizationError}. Playwright will need ignoreHTTPSErrors, which hides real problems.`);
    }

    // Only trust the expiry reading when we are looking at the origin's cert.
    if (!tls.intercepted && tls.daysRemaining != null) {
      if (tls.daysRemaining < 0) fail(`TLS certificate expired ${Math.abs(tls.daysRemaining)} days ago.`);
      else if (tls.daysRemaining <= T.certWarnDays) warn(`TLS certificate expires in ${tls.daysRemaining} days — inside the engagement window.`);
    }
  } else if (trustFailure) {
    fail(`TLS verification failed (${trustFailure}) and the certificate could not be read for diagnosis.`);
  }

  if (reasons.length === 0) reasons.push('No blocking issues found.');

  return {
    name,
    url,
    finalUrl: first.finalUrl,
    verdict,
    reasons,
    dns,
    redirectChain: first.chain,
    tls,
    response: {
      status: final.status,
      contentType: final.headers?.['content-type'] ?? null,
      bytes: final.bytes ?? null,
      title: extractTitle(final.body),
      server: final.headers?.server ?? null,
      poweredBy: final.headers?.['x-powered-by'] ?? null,
      setCookieNames: cookieNames(final.headers?.['set-cookie']),
    },
    gates,
    tlsVerificationBypassed: insecure,
    tlsTrustError: trustFailure,
    stability: {
      samples: opts.samples,
      intervalMs: opts.interval,
      errors,
      errorPct: round(errorPct),
      statusCounts: Object.fromEntries(statuses),
      ttfb: ttfbStats,
      total: totalStats,
    },
  };
}

// ---------------------------------------------------------------- reporting
function renderReport(result) {
  const L = [];
  const icon = { READY: 'READY     ', DEGRADED: 'DEGRADED  ', NOT_READY: 'NOT_READY ' };
  L.push('');
  L.push('='.repeat(72));
  L.push(`STAGING READINESS PROBE  —  ${result.startedAt}`);
  L.push('='.repeat(72));

  for (const t of result.targets) {
    L.push('');
    L.push(`[${icon[t.verdict]}] ${t.name}: ${t.url}`);
    L.push('-'.repeat(72));
    if (t.finalUrl && t.finalUrl !== t.url) L.push(`  resolves to     ${t.finalUrl}`);
    if (t.dns?.ok) L.push(`  dns             ${t.dns.address} (${round(t.dns.ms)}ms)`);
    if (t.redirectChain?.length > 1) {
      L.push(`  redirects       ${t.redirectChain.map((c) => c.status).join(' -> ')}`);
      for (const c of t.redirectChain.slice(0, -1)) L.push(`                    ${c.status} ${c.url} -> ${c.location}`);
    }
    if (t.response) {
      L.push(`  status          ${t.response.status}  ${t.response.contentType ?? ''}`);
      if (t.response.title) L.push(`  page title      ${t.response.title}`);
      if (t.response.server) L.push(`  server          ${t.response.server}`);
      if (t.response.setCookieNames?.length) L.push(`  cookies set     ${t.response.setCookieNames.join(', ')} (names only)`);
    }
    if (t.tls) {
      const expiry = t.tls.intercepted ? `${t.tls.daysRemaining}d (proxy cert — not the origin's)` : `expires in ${t.tls.daysRemaining}d`;
      L.push(`  tls             ${t.tls.subject ?? '?'} / ${t.tls.issuer ?? '?'} — ${expiry}`);
    }
    if (t.tlsVerificationBypassed) {
      L.push(`  NOTE            certificate verification was bypassed to collect the readings above (${t.tlsTrustError}).`);
    }
    if (t.stability?.total) {
      const s = t.stability;
      L.push(`  latency total   p50 ${s.total.p50Ms}ms  p95 ${s.total.p95Ms}ms  max ${s.total.maxMs}ms  (n=${s.total.n})`);
      if (s.ttfb) L.push(`  latency ttfb    p50 ${s.ttfb.p50Ms}ms  p95 ${s.ttfb.p95Ms}ms  max ${s.ttfb.maxMs}ms`);
      L.push(`  errors          ${s.errors}/${s.samples} (${s.errorPct}%)`);
    }
    L.push(`  findings:`);
    for (const r of t.reasons) L.push(`    - ${r}`);
  }

  L.push('');
  L.push('='.repeat(72));
  L.push(`OVERALL: ${result.verdict}`);
  L.push(result.recommendation);
  if (result.productionOverride) {
    L.push(`PRODUCTION OVERRIDE USED for ${result.productionOverride.hosts}`);
    L.push(`  approval on file: ${result.productionOverride.approval}`);
  }
  L.push('='.repeat(72));
  L.push('');
  return L.join('\n');
}

const RECOMMENDATION = {
  READY: 'Environment is reachable and stable. Safe to point the suite at it.',
  DEGRADED: 'Environment is usable but will generate flake. Fix the findings above, or budget for raised timeouts and expect a noisier signal.',
  NOT_READY: 'Do not point the suite at this environment yet. The findings above are environment problems, and every test failure they cause will be misread as a test bug.',
};

// ---------------------------------------------------------------- main
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(3);
  }

  if (opts.help || !opts.url) {
    console.error(USAGE);
    process.exit(opts.help ? 0 : 3);
  }
  if (!Number.isFinite(opts.samples) || opts.samples < 1) {
    console.error('--samples must be a positive number.');
    process.exit(3);
  }

  const targets = [{ name: 'web app', url: opts.url }];
  if (opts.api) targets.push({ name: 'api', url: opts.api });

  let productionOverride = null;
  try {
    productionOverride = assertNotProduction(targets, opts);
  } catch (err) {
    console.error(`\n[PRODUCTION GUARD]\n${err.message}\n`);
    process.exit(3);
  }

  const startedAt = new Date().toISOString();
  const results = [];
  for (const t of targets) {
    results.push(await probeTarget(t.name, t.url, opts));
  }

  const worst = results.reduce(
    (acc, r) => (r.verdict === 'NOT_READY' ? 'NOT_READY' : r.verdict === 'DEGRADED' && acc !== 'NOT_READY' ? 'DEGRADED' : acc),
    'READY'
  );

  const result = {
    startedAt,
    finishedAt: new Date().toISOString(),
    verdict: worst,
    recommendation: RECOMMENDATION[worst],
    productionOverride,
    config: { samples: opts.samples, intervalMs: opts.interval, timeoutMs: opts.timeout },
    targets: results,
  };

  console.log(renderReport(result));

  if (opts.json) {
    writeFileSync(opts.json, JSON.stringify(result, null, 2));
    console.log(`Full result written to ${opts.json}`);
  }

  process.exit(worst === 'READY' ? 0 : worst === 'DEGRADED' ? 1 : 2);
}

main().catch((err) => {
  console.error(`Probe crashed: ${err?.stack ?? err}`);
  process.exit(3);
});
