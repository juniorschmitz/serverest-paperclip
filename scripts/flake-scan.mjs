#!/usr/bin/env node
/**
 * Per-test flake attribution for CI.
 *
 * This is not `scripts/reliability.mjs`, and the difference matters:
 *
 *   reliability.mjs  "is this test ready to ship?"  — run-level pass/fail over
 *                    N consecutive runs, red if any run was red. The bar a test
 *                    clears before it is committed.
 *   flake-scan.mjs   "which test is unstable?"      — per-test pass rate across
 *                    N runs, so a flake can be named, owned and quarantined.
 *
 * The CI gate runs with --retries=0, so it can say the suite went red but not
 * which test is unreliable. This answers that, nightly, off the gating path.
 *
 *   node scripts/flake-scan.mjs --repeats 5
 *   node scripts/flake-scan.mjs --repeats 3 --grep @smoke --project api
 *
 * Output: flake-scans/<stamp>/ with per-run JSON, summary.json and summary.md,
 * plus a `latest` copy that CI publishes to the run summary.
 *
 * Exit 0 if every test was perfectly consistent, 1 if any test was not,
 * 2 on infrastructure failure. Never gates a change.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Run the Playwright CLI through this Node binary rather than through `npx`:
// Node on Windows refuses to spawnSync a `.cmd` shim without `shell: true`, and
// enabling the shell subjects every argument to shell quoting. Same reasoning
// as scripts/reliability.mjs.
const require = createRequire(import.meta.url);
const playwrightCli = require.resolve('@playwright/test/cli');

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const repeats = Number.parseInt(readFlag('repeats', '5'), 10);
const grep = readFlag('grep', '');
const project = readFlag('project', '');

if (!Number.isInteger(repeats) || repeats < 2) {
  console.error('--repeats must be an integer >= 2 (a single run cannot detect a flake).');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runRoot = join('flake-scans', stamp);
mkdirSync(runRoot, { recursive: true });

console.log(
  `Flake scan: ${repeats} runs${grep ? ` (grep ${grep})` : ''}${project ? ` (project ${project})` : ''}`,
);

// --- collect ----------------------------------------------------------------
const seen = new Map();
const runMeta = [];

function collectTests(report) {
  const rows = [];
  // The root suite's title is the file path, so the describe chain starts at
  // its children — otherwise every title is prefixed with its own filename.
  const visit = (suite, filePath, ancestors) => {
    const file = suite.file ?? filePath;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        rows.push({
          title: [...ancestors, spec.title].filter(Boolean).join(' > ') || spec.title,
          file: file ?? '(unknown)',
          line: spec.line,
          project: test.projectName ?? '',
          outcome: test.status ?? 'unknown',
          duration: (test.results ?? []).reduce((s, r) => s + (r.duration ?? 0), 0),
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, file, [...ancestors, child.title]);
  };
  for (const suite of report.suites ?? []) visit(suite, suite.file, []);
  return rows;
}

for (let run = 1; run <= repeats; run++) {
  const jsonPath = join(runRoot, `run-${run}.json`);
  const args = [playwrightCli, 'test', '--retries=0', '--reporter=json'];
  if (grep) args.push(`--grep=${grep}`);
  if (project) args.push(`--project=${project}`);

  const started = Date.now();
  const res = spawnSync(process.execPath, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath,
      // Distinct identities per run so a leak from one run cannot collide with
      // the next and produce a failure that looks like flake but is our mess.
      TEST_RUN_ID: `${process.env.TEST_RUN_ID ?? 'scan'}-r${run}`,
    },
  });
  const elapsed = Date.now() - started;

  // A runner that never started is not a test failure, and must not be counted
  // as one — an empty report plus a red exit reads as a broken suite.
  if (res.error) {
    console.warn(`  run ${run}: runner could not start: ${res.error.message}`);
    runMeta.push({ run, exitCode: null, elapsedMs: elapsed, runnerError: res.error.message, reportMissing: true });
    continue;
  }

  console.log(`  run ${run}/${repeats}: exit ${res.status} in ${Math.round(elapsed / 1000)}s`);

  if (!existsSync(jsonPath)) {
    console.warn(`  run ${run}: no JSON report produced — counting as an infrastructure error.`);
    runMeta.push({ run, exitCode: res.status, elapsedMs: elapsed, reportMissing: true });
    continue;
  }

  let report;
  try {
    report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    console.warn(`  run ${run}: unparseable report (${err.message})`);
    runMeta.push({ run, exitCode: res.status, elapsedMs: elapsed, reportUnparseable: true });
    continue;
  }

  runMeta.push({ run, exitCode: res.status, elapsedMs: elapsed });

  for (const t of collectTests(report)) {
    const key = `${t.project} ${t.file} ${t.title}`;
    if (!seen.has(key)) {
      seen.set(key, {
        title: t.title,
        file: t.file,
        line: t.line,
        project: t.project,
        outcomes: [],
        durations: [],
      });
    }
    const entry = seen.get(key);
    entry.outcomes.push(t.outcome);
    entry.durations.push(t.duration);
  }
}

// --- classify ---------------------------------------------------------------
const completedRuns = runMeta.filter((r) => !r.reportMissing && !r.reportUnparseable).length;

const analysed = [...seen.values()].map((entry) => {
  // Only runs where the test actually executed count. A test skipped in some
  // runs is not thereby a flake.
  const executed = entry.outcomes.filter((o) => o !== 'skipped');
  const passes = executed.filter((o) => o === 'expected').length;
  const fails = executed.length - passes;
  const observed = executed.length;

  let verdict;
  if (observed === 0) verdict = 'never-ran';
  else if (passes === observed) verdict = 'stable-pass';
  else if (fails === observed) verdict = 'consistent-fail'; // a real bug, not a flake
  else verdict = 'FLAKY';

  return {
    ...entry,
    observed,
    passes,
    fails,
    passRatePct: observed === 0 ? null : Number(((passes / observed) * 100).toFixed(1)),
    // A test absent from some runs is itself suspicious (worker crash, changed
    // shard boundary) — surface it rather than hide it.
    missingFromRuns: completedRuns - entry.outcomes.length,
    verdict,
  };
});

const flaky = analysed
  .filter((t) => t.verdict === 'FLAKY')
  .sort((a, b) => a.passRatePct - b.passRatePct);
const consistentFail = analysed.filter((t) => t.verdict === 'consistent-fail');
const stable = analysed.filter((t) => t.verdict === 'stable-pass');
const partiallyMissing = analysed.filter((t) => t.missingFromRuns > 0);

const summary = {
  stamp,
  repeats,
  completedRuns,
  grep: grep || null,
  project: project || null,
  runs: runMeta,
  totals: {
    tests: analysed.length,
    stable: stable.length,
    flaky: flaky.length,
    consistentFail: consistentFail.length,
    partiallyMissing: partiallyMissing.length,
  },
  flaky: flaky.map((t) => ({
    title: t.title,
    file: t.file,
    line: t.line,
    project: t.project,
    passRatePct: t.passRatePct,
    passes: t.passes,
    observed: t.observed,
  })),
  consistentFail: consistentFail.map((t) => ({ title: t.title, file: t.file, project: t.project })),
};

writeFileSync(join(runRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

// --- markdown ---------------------------------------------------------------
const md = [];
md.push(`## Flake scan — ${completedRuns}/${repeats} runs completed`);
md.push('');
md.push('| Metric | Value |');
md.push('| --- | --- |');
md.push(`| Tests observed | ${analysed.length} |`);
md.push(`| Stable (100% pass) | ${stable.length} |`);
md.push(`| **Flaky (inconsistent)** | **${flaky.length}** |`);
md.push(`| Consistent failures (real bugs, not flakes) | ${consistentFail.length} |`);
md.push(`| Missing from some runs | ${partiallyMissing.length} |`);
md.push('');

if (flaky.length > 0) {
  md.push('### Flake candidates');
  md.push('');
  md.push('| Pass rate | Test | Project | Location |');
  md.push('| --- | --- | --- | --- |');
  for (const t of flaky) {
    md.push(
      `| ${t.passRatePct}% (${t.passes}/${t.observed}) | ${t.title} | ${t.project || 'default'} | \`${t.file}:${t.line ?? '?'}\` |`,
    );
  }
  md.push('');
  md.push(
    'Each needs a triage decision within one working day — fix, quarantine, or reject as a real bug. See `docs/flake-policy.md`.',
  );
  md.push('');
} else {
  md.push('No flakes detected. Every test that ran was consistent across all runs.');
  md.push('');
}

if (consistentFail.length > 0) {
  md.push('### Consistent failures');
  md.push('');
  md.push('These failed in **every** run — a broken test or a real product bug. Do not quarantine them.');
  md.push('');
  for (const t of consistentFail) {
    md.push(`- \`${t.project || 'default'}\` ${t.title} — \`${t.file}\``);
  }
  md.push('');
}

writeFileSync(join(runRoot, 'summary.md'), `${md.join('\n')}\n`);

// `latest` is what CI publishes, so the workflow need not know the stamp.
const latest = join('flake-scans', 'latest');
rmSync(latest, { recursive: true, force: true });
cpSync(runRoot, latest, { recursive: true });

console.log(`\n${md.join('\n')}`);
console.log(`Full output: ${runRoot}`);

if (completedRuns === 0) {
  console.error('No run produced a usable report — treating as an infrastructure failure.');
  process.exit(2);
}

process.exit(flaky.length > 0 ? 1 : 0);
