#!/usr/bin/env node
/**
 * Failure notification. Optional: reads SLACK_WEBHOOK_URL from the environment
 * and no-ops cleanly when it is absent, so the pipeline works with zero secrets
 * configured (GitHub already emails the pushing author on a failed run).
 *
 *   node scripts/notify-slack.mjs --report ci-health.json --run-url <url>
 *   node scripts/notify-slack.mjs --flake-scan flake-scans/latest/summary.json --run-url <url>
 *
 * Never fails the build: a broken notifier must not turn a green run red, nor a
 * red run into a confusing one. All errors are logged and swallowed.
 */
import { existsSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};

const webhook = process.env.SLACK_WEBHOOK_URL;
if (!webhook) {
  console.log('SLACK_WEBHOOK_URL not set — no notification sent.');
  process.exit(0);
}

const runUrl = flag('run-url') ?? '';
const repo = process.env.GITHUB_REPOSITORY ?? 'the repo';
const ref = process.env.GITHUB_REF_NAME ?? 'unknown ref';
const actor = process.env.GITHUB_ACTOR ?? 'unknown';
const sha = (process.env.GITHUB_SHA ?? '').slice(0, 8);

const read = (path) => {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.log(`Could not parse ${path}: ${err.message}`);
    return null;
  }
};

let text;
const healthPath = flag('report');
const flakeScanPath = flag('flake-scan');

if (flakeScanPath) {
  const summary = read(flakeScanPath);
  if (!summary) {
    console.log('No flake-scan summary to report — skipping notification.');
    process.exit(0);
  }
  const flakeCount = summary.totals?.flaky ?? 0;
  if (flakeCount === 0) {
    console.log('No flakes detected — nothing worth a notification.');
    process.exit(0);
  }
  const lines = summary.flaky
    .slice(0, 10)
    .map((t) => `• *${t.passRatePct}%* (${t.passes}/${t.observed}) — ${t.title} \`${t.project || 'default'}\``);
  text = [
    `:rotating_light: *${flakeCount} flaky test(s)* detected in \`${repo}\` over ${summary.completedRuns} runs.`,
    ...lines,
    summary.flaky.length > 10 ? `…and ${summary.flaky.length - 10} more.` : '',
    'Triage within one working day: fix, quarantine, or reject as a real bug (`docs/flake-policy.md`).',
    runUrl ? `<${runUrl}|Open the flake scan>` : '',
  ]
    .filter(Boolean)
    .join('\n');
} else {
  const health = read(healthPath);
  const detail = health
    ? [
        `Pass rate: *${health.passRatePct ?? 'n/a'}%* (${health.totals?.passed ?? '?'}/${health.totals?.executed ?? '?'})`,
        `Failed: *${health.totals?.failed ?? '?'}*`,
      ].join('  |  ')
    : 'No health metrics were produced — the run may have failed before the tests ran.';

  const failures = (health?.failures ?? [])
    .slice(0, 10)
    .map((f) => `• ${f.title} \`${f.file}:${f.line ?? '?'}\``);

  text = [
    `:red_circle: *Suite failed* on \`${repo}\` (\`${ref}\` @ ${sha || 'unknown'}, pushed by ${actor})`,
    detail,
    ...failures,
    (health?.failures?.length ?? 0) > 10 ? `…and ${health.failures.length - 10} more.` : '',
    runUrl ? `<${runUrl}|Open the run> — traces are in the *playwright-report* artifact.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

try {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    console.log(`Slack webhook returned ${res.status} ${res.statusText}. Notification not delivered.`);
  } else {
    console.log('Notification sent.');
  }
} catch (err) {
  // Deliberately non-fatal — see the header comment.
  console.log(`Notification failed: ${err.message}`);
}
