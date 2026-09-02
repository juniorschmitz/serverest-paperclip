#!/usr/bin/env node
/**
 * Turn a Playwright JSON report into the numbers this engagement reports on:
 * pass rate, runtime, flake count.
 *
 *   node scripts/ci-health.mjs merged-report.json
 *
 * Writes a markdown table to $GITHUB_STEP_SUMMARY (stdout when running local)
 * and a machine-readable ci-health.json for trend tracking.
 *
 * Exit code is always 0 — this script reports, it does not gate. The gate is
 * the test result itself (see .github/workflows/tests.yml).
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const reportPath = process.argv[2] ?? 'merged-report.json';

/** Walk the nested suite/spec tree and flatten to one row per test. */
function collectTests(report) {
  const rows = [];

  // `ancestors` is the chain of describe-block titles. The root suite's title
  // is the file path, so it is deliberately not part of the chain — otherwise
  // every test title would be prefixed with its own filename.
  const visit = (suite, filePath, ancestors) => {
    const file = suite.file ?? filePath;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        // Playwright reports duration per attempt; the cost of a spec is the
        // sum of its attempts, because that is the wall-clock it consumed.
        const duration = results.reduce((sum, r) => sum + (r.duration ?? 0), 0);
        rows.push({
          title: [...ancestors, spec.title].filter(Boolean).join(' > ') || spec.title,
          file: file ?? '(unknown)',
          line: spec.line,
          project: test.projectName ?? '',
          // `status` here is Playwright's *outcome*: expected | unexpected |
          // flaky | skipped. "flaky" means it failed then passed on a retry.
          outcome: test.status ?? 'unknown',
          attempts: results.length,
          duration,
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, file, [...ancestors, child.title]);
  };

  for (const suite of report.suites ?? []) visit(suite, suite.file, []);
  return rows;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  // Sub-second matters here: a test that dies in worker setup takes ~4ms, and
  // rounding that to "0s" hides the difference between "instant" and "fast".
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (err) {
  const msg = `Could not read a Playwright JSON report at ${reportPath}: ${err.message}`;
  console.log(`::warning::${msg}`);
  emit(`### Pipeline health\n\n:warning: ${msg}\n`);
  process.exit(0);
}

const tests = collectTests(report);
const stats = report.stats ?? {};

const skipped = tests.filter((t) => t.outcome === 'skipped');
const passed = tests.filter((t) => t.outcome === 'expected');
const failed = tests.filter((t) => t.outcome === 'unexpected');
const flaky = tests.filter((t) => t.outcome === 'flaky');

// Skipped tests are excluded from the denominator: a skipped test is neither a
// pass nor a failure, and counting it as either makes the rate a lie.
const executed = passed.length + failed.length + flaky.length;
const passRate = executed === 0 ? null : (passed.length / executed) * 100;

// Wall-clock of the whole run when the report carries it, otherwise the sum of
// test durations (an over-estimate under parallelism, so it is labelled).
const wallClock = Number.isFinite(stats.duration) ? stats.duration : null;
const testTime = tests.reduce((sum, t) => sum + t.duration, 0);

const slowest = [...tests].sort((a, b) => b.duration - a.duration).slice(0, 10);

const health = {
  generatedFrom: reportPath,
  runUrl:
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
  commit: process.env.GITHUB_SHA ?? null,
  ref: process.env.GITHUB_REF_NAME ?? null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  totals: {
    total: tests.length,
    executed,
    passed: passed.length,
    failed: failed.length,
    flaky: flaky.length,
    skipped: skipped.length,
  },
  passRatePct: passRate === null ? null : Number(passRate.toFixed(2)),
  wallClockMs: wallClock,
  totalTestTimeMs: testTime,
  failures: failed.map((t) => ({ title: t.title, file: t.file, line: t.line, project: t.project })),
  flaky: flaky.map((t) => ({
    title: t.title,
    file: t.file,
    line: t.line,
    project: t.project,
    attempts: t.attempts,
  })),
  slowest: slowest.map((t) => ({ title: t.title, project: t.project, durationMs: t.duration })),
};

writeFileSync('ci-health.json', `${JSON.stringify(health, null, 2)}\n`);

// ---------------------------------------------------------------------------
// Human-readable summary
// ---------------------------------------------------------------------------
const verdict = failed.length > 0 ? ':red_circle: RED' : executed === 0 ? ':warning: NO TESTS RAN' : ':green_circle: GREEN';

const lines = [];
lines.push(`## ${verdict} — pipeline health`);
lines.push('');
lines.push('| Metric | Value |');
lines.push('| --- | --- |');
lines.push(`| Pass rate | ${passRate === null ? 'n/a' : `${passRate.toFixed(1)}% (${passed.length}/${executed})`} |`);
lines.push(`| Runtime (wall clock) | ${wallClock === null ? 'n/a' : fmtDuration(wallClock)} |`);
lines.push(`| Total test time | ${fmtDuration(testTime)} |`);
lines.push(`| Failed | ${failed.length} |`);
lines.push(`| Flaky (retried and passed) | ${flaky.length} |`);
lines.push(`| Skipped | ${skipped.length} |`);
lines.push(`| Total tests | ${tests.length} |`);
lines.push('');

if (failed.length > 0) {
  lines.push('### Failures');
  lines.push('');
  for (const t of failed) {
    lines.push(`- \`${t.project || 'default'}\` **${t.title}** — \`${t.file}:${t.line ?? '?'}\``);
  }
  lines.push('');
  lines.push('Open the **playwright-report** artifact on this run; each failure has a trace attached.');
  lines.push('');
}

if (flaky.length > 0) {
  // The gate runs --retries=0, so this should be structurally impossible.
  // If it ever fires, a retry setting leaked in and the signal is degraded.
  lines.push('### :rotating_light: Flaky results present');
  lines.push('');
  lines.push(
    'The gate runs with `--retries=0`, so a "flaky" outcome means retries were enabled somewhere. ' +
      'That is a policy violation, not a pass — see `docs/flake-policy.md`.',
  );
  lines.push('');
  for (const t of flaky) {
    lines.push(`- \`${t.project || 'default'}\` **${t.title}** — ${t.attempts} attempts — \`${t.file}:${t.line ?? '?'}\``);
  }
  lines.push('');
}

if (slowest.length > 0 && slowest[0].duration > 0) {
  lines.push('<details><summary>Slowest 10 tests (runtime budget)</summary>');
  lines.push('');
  lines.push('| Test | Project | Duration |');
  lines.push('| --- | --- | --- |');
  for (const t of slowest) {
    lines.push(`| ${t.title} | ${t.project || 'default'} | ${fmtDuration(t.duration)} |`);
  }
  lines.push('');
  lines.push('</details>');
  lines.push('');
}

emit(lines.join('\n'));

function emit(markdown) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) {
    appendFileSync(target, `${markdown}\n`);
  }
  // Always echo to the log too, so the numbers survive in the raw job output.
  console.log(markdown);
}
