#!/usr/bin/env node
/**
 * Run the suite N times and report whether every run was green.
 *
 * The bar on this engagement is that a test ships only after ten consecutive
 * clean runs. That number is not superstition: with retries disabled, a test
 * that fails one run in twenty is invisible in a single run and obvious in ten,
 * and the cheapest moment to find it is before it is in CI gating other
 * people's work.
 *
 *   npm run reliability                          # 10 runs, whole suite
 *   npm run reliability -- 20                    # 20 runs
 *   npm run reliability -- --repeats 20          # the same, spelled the other way
 *   npm run reliability -- 10 --project=api
 *   npm run reliability -- --repeats 10 --grep '<test title>'
 *
 * For "which test is unstable?" rather than "is this run green?", use
 * scripts/flake-scan.mjs, which reports per-test pass rates.
 *
 * A single red run fails the whole thing and prints which run and which test,
 * because "it passed nine times" is not a result.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * Run the Playwright CLI through this Node binary rather than through `npx`.
 *
 * Two reasons. Node on Windows refuses to spawnSync a `.cmd` shim without
 * `shell: true` (EINVAL), and turning the shell on to work around that means
 * every argument becomes subject to shell quoting. Resolving the CLI entry
 * point and executing it directly avoids both, and works the same on every
 * platform.
 */
const require = createRequire(import.meta.url);
const playwrightCli = require.resolve('@playwright/test/cli');

// Two spellings of the run count, because both are in use: `-- 10` in
// docs/ci.md and the strategy, `--repeats 10` in docs/flake-policy.md and
// docs/quarantine.md, alongside scripts/flake-scan.mjs which takes --repeats.
// Everything else is forwarded to Playwright untouched and in order, so
// `--grep '<test title>'` and `--project=api` work as the docs describe.
const argv = process.argv.slice(2);
let runs = 10;
const passthrough = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];

  if (arg === '--repeats') {
    runs = Number(argv[i + 1]);
    i += 1;
    continue;
  }
  // A bare number, but only as the first argument — anywhere else it is far
  // more likely to be the value of a flag such as `--workers 4`.
  if (i === 0 && /^\d+$/.test(arg)) {
    runs = Number(arg);
    continue;
  }
  passthrough.push(arg);
}

if (!Number.isInteger(runs) || runs < 1) {
  console.error(`Run count must be a positive integer; got "${runs}".`);
  process.exit(2);
}

const outDir = 'reliability-runs';
mkdirSync(outDir, { recursive: true });

const results = [];
let firstFailure = null;

console.log(`Reliability check: ${runs} consecutive runs${passthrough.length ? ` (${passthrough.join(' ')})` : ''}\n`);

for (let run = 1; run <= runs; run += 1) {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [playwrightCli, 'test', '--reporter=line', ...passthrough],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        // Distinct identities per run, so a leak from run 3 cannot collide with
        // run 4 and produce a failure that looks like flake but is our own mess.
        TEST_RUN_ID: `rel${run}`,
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const passed = result.status === 0;
  // If the process never started, say so. An empty log plus a 0.0s "FAIL"
  // reads as a broken suite when it is really a broken runner.
  const output = result.error
    ? `runner could not start the test process: ${result.error.message}\n`
    : `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(join(outDir, `run-${String(run).padStart(2, '0')}.log`), output, 'utf8');

  results.push({ run, passed, seconds });
  console.log(`  run ${String(run).padStart(2, ' ')}/${runs}  ${passed ? 'PASS' : 'FAIL'}  ${seconds}s`);

  if (!passed && !firstFailure) {
    firstFailure = { run, output };
  }
}

const failures = results.filter((r) => !r.passed);
const times = results.map((r) => Number(r.seconds));

console.log('\n──────────────────────────────────────────');
console.log(`green: ${results.length - failures.length}/${runs}`);
console.log(
  `time:  min ${Math.min(...times).toFixed(1)}s  max ${Math.max(...times).toFixed(1)}s  ` +
    `mean ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)}s`,
);
console.log(`logs:  ${outDir}/`);

if (failures.length > 0) {
  console.log(`\nFAILED on run(s) ${failures.map((f) => f.run).join(', ')}.`);
  console.log('First failure output:\n');
  const interesting = firstFailure.output
    .split('\n')
    .filter((line) => /✘|×|Error|failed|expect|runner could not|at /.test(line))
    .slice(0, 40);
  console.log(interesting.length ? interesting.join('\n') : firstFailure.output.slice(0, 2000));
  console.log(
    '\nDo not retry your way out of this. Find why it failed — unique data, token lifetime, ' +
      'an assertion on shared state, or a real defect.',
  );
  process.exit(1);
}

console.log(`\n${runs}/${runs} green. The suite meets the reliability bar.`);
