#!/usr/bin/env node
/**
 * Publish the quarantine list and how the quarantined tests did on this run.
 *
 *   node scripts/quarantine-report.mjs quarantine-report.json >> "$GITHUB_STEP_SUMMARY"
 *
 * Quarantined tests do not gate a change, which is precisely why their results
 * have to appear on every run. A quarantined test that has started passing
 * consistently should come back; one that has started failing differently is
 * new information. Both are invisible unless someone prints them.
 *
 * Always exits 0 — this job is non-blocking by design.
 */
import { existsSync, readFileSync } from 'node:fs';

const reportPath = process.argv[2] ?? 'quarantine-report.json';
const LIST_PATH = 'docs/quarantine.md';

const out = [];
out.push('## Quarantined tests (non-blocking)');
out.push('');

// --- the list ---------------------------------------------------------------
let listedRows = [];
if (existsSync(LIST_PATH)) {
  const source = readFileSync(LIST_PATH, 'utf8');
  const start = source.indexOf('<!-- QUARANTINE-TABLE-START -->');
  const end = source.indexOf('<!-- QUARANTINE-TABLE-END -->');
  if (start !== -1 && end > start) {
    listedRows = source
      .slice(start, end)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('|'))
      .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
      .filter((cells) => !cells.every((c) => /^-{2,}$/.test(c) || c === ''))
      .filter((cells) => cells[0]?.toLowerCase() !== 'test');
  }
}

if (listedRows.length === 0) {
  out.push('Nothing is quarantined. Every test in the suite gates changes.');
  out.push('');
} else {
  out.push(`**${listedRows.length} test(s) are excluded from the gate.**`);
  out.push('');
  out.push('| Test | Project | Review by | Owner | Issue |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const cells of listedRows) {
    const [test, project, , reviewBy, owner, issue] = cells;
    out.push(`| ${test} | ${project} | ${reviewBy} | ${owner} | ${issue} |`);
  }
  out.push('');
  out.push(`Full detail and policy: \`${LIST_PATH}\`.`);
  out.push('');
}

// --- how they actually did --------------------------------------------------
function collect(report) {
  const rows = [];
  const visit = (suite, filePath, ancestors) => {
    const file = suite.file ?? filePath;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        rows.push({
          title: [...ancestors, spec.title].filter(Boolean).join(' > ') || spec.title,
          project: test.projectName ?? '',
          outcome: test.status ?? 'unknown',
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, file, [...ancestors, child.title]);
  };
  for (const suite of report.suites ?? []) visit(suite, suite.file, []);
  return rows;
}

if (!existsSync(reportPath)) {
  out.push('_No result report for this run — the quarantine job produced no output._');
} else {
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (err) {
    out.push(`_Could not parse \`${reportPath}\`: ${err.message}_`);
    report = null;
  }

  if (report) {
    const tests = collect(report);
    if (tests.length === 0) {
      out.push('_No quarantined tests were executed on this run._');
    } else {
      const passed = tests.filter((t) => t.outcome === 'expected');
      out.push('### Results this run');
      out.push('');
      out.push(`${passed.length}/${tests.length} quarantined tests passed.`);
      out.push('');
      out.push('| Result | Test | Project |');
      out.push('| --- | --- | --- |');
      for (const t of tests) {
        const icon = t.outcome === 'expected' ? ':white_check_mark:' : t.outcome === 'skipped' ? ':fast_forward:' : ':x:';
        out.push(`| ${icon} ${t.outcome} | ${t.title} | ${t.project || 'default'} |`);
      }
      out.push('');
      if (passed.length === tests.length && tests.length > 0) {
        out.push(
          ':arrow_right: **All quarantined tests passed.** Confirm with ' +
            '`npm run reliability -- --repeats 10` and take them back out of quarantine.',
        );
        out.push('');
      }
    }
  }
}

console.log(out.join('\n'));
