#!/usr/bin/env node
/**
 * Enforce the quarantine list in docs/quarantine.md.
 *
 *   node scripts/quarantine-audit.mjs
 *
 * Quarantine is the only sanctioned way to stop a test gating changes, so it
 * needs a hard boundary or it becomes a graveyard. This runs in the CI `setup`
 * job and fails the build when:
 *
 *   - a test is tagged @quarantine in code but has no row in the list (or vice versa)
 *   - a row is missing an owner, an issue, or a date
 *   - a row is past its `Review by` date
 *   - an entry has been quarantined longer than MAX_DAYS
 *   - more tests are quarantined than the cap allows
 *
 * Exit 0 = clean, 1 = policy violation.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LIST_PATH = 'docs/quarantine.md';
const TESTS_DIR = 'tests';
const MAX_DAYS = 14;
const MIN_CAP = 5;
const CAP_FRACTION = 0.02; // or 2% of the suite, whichever is larger

const problems = [];
const notes = [];

// --- parse the list ---------------------------------------------------------
if (!existsSync(LIST_PATH)) {
  console.error(`::error::${LIST_PATH} is missing. The quarantine list must exist, even when empty.`);
  process.exit(1);
}

const listSource = readFileSync(LIST_PATH, 'utf8');
const start = listSource.indexOf('<!-- QUARANTINE-TABLE-START -->');
const end = listSource.indexOf('<!-- QUARANTINE-TABLE-END -->');

if (start === -1 || end === -1 || end < start) {
  console.error(`::error::${LIST_PATH} has no QUARANTINE-TABLE-START/END markers — the audit cannot tell live entries from examples.`);
  process.exit(1);
}

const COLUMNS = ['test', 'project', 'quarantined', 'reviewBy', 'owner', 'issue', 'reason'];

const rows = [];
for (const rawLine of listSource.slice(start, end).split('\n')) {
  const line = rawLine.trim();
  if (!line.startsWith('|')) continue;

  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  // Header row and the |---|---| separator are not entries.
  if (cells.every((c) => /^-{2,}$/.test(c) || c === '')) continue;
  if (cells[0]?.toLowerCase() === 'test') continue;

  if (cells.length !== COLUMNS.length) {
    problems.push(`Row has ${cells.length} columns, expected ${COLUMNS.length}: ${line}`);
    continue;
  }
  rows.push(Object.fromEntries(COLUMNS.map((name, i) => [name, cells[i]])));
}

// --- validate each row ------------------------------------------------------
const today = new Date();
today.setUTCHours(0, 0, 0, 0);

const parseDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const daysBetween = (a, b) => Math.round((a - b) / 86_400_000);

for (const row of rows) {
  const label = row.test || '(untitled row)';

  for (const field of COLUMNS) {
    if (!row[field]) problems.push(`"${label}": column \`${field}\` is empty — every field is required.`);
  }

  const quarantined = parseDate(row.quarantined);
  const reviewBy = parseDate(row.reviewBy);

  if (row.quarantined && !quarantined) {
    problems.push(`"${label}": \`Quarantined\` is "${row.quarantined}", expected YYYY-MM-DD.`);
  }
  if (row.reviewBy && !reviewBy) {
    problems.push(`"${label}": \`Review by\` is "${row.reviewBy}", expected YYYY-MM-DD.`);
  }

  if (quarantined && reviewBy) {
    const window = daysBetween(reviewBy, quarantined);
    if (window > MAX_DAYS) {
      problems.push(
        `"${label}": review window is ${window} days, the policy maximum is ${MAX_DAYS}. Shorten it or fix the test.`,
      );
    }
    if (window < 0) {
      problems.push(`"${label}": \`Review by\` (${row.reviewBy}) is before \`Quarantined\` (${row.quarantined}).`);
    }
  }

  if (reviewBy && reviewBy < today) {
    const overdue = daysBetween(today, reviewBy);
    problems.push(
      `"${label}": OVERDUE by ${overdue} day${overdue === 1 ? '' : 's'} (review by ${row.reviewBy}, owner ${row.owner || 'UNASSIGNED'}, issue ${row.issue || 'NONE'}). Resolve the test — do not extend the date.`,
    );
  } else if (reviewBy) {
    const left = daysBetween(reviewBy, today);
    if (left <= 3) notes.push(`"${label}" is due for review in ${left} day${left === 1 ? '' : 's'} (${row.owner}).`);
  }

  if (row.owner && /team|squad|everyone|tbd|n\/a/i.test(row.owner)) {
    problems.push(`"${label}": owner "${row.owner}" is not a named person. Quarantine needs one accountable owner.`);
  }
}

// --- reconcile the list against the code ------------------------------------
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(spec|test)\.[tj]s$/.test(name)) out.push(full);
  }
  return out;
}

let taggedInCode = 0;
if (existsSync(TESTS_DIR)) {
  for (const file of walk(TESTS_DIR)) {
    const source = readFileSync(file, 'utf8');
    // Count @quarantine occurrences in test titles / tag arrays.
    taggedInCode += (source.match(/@quarantine/g) ?? []).length;
  }

  if (taggedInCode !== rows.length) {
    problems.push(
      `Code has ${taggedInCode} @quarantine tag(s) but ${LIST_PATH} lists ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}. ` +
        'Tag and list must change in the same commit, otherwise a test drops out of the gate invisibly.',
    );
  }

  // Cap: max(MIN_CAP, 2% of suite). Approximates suite size by counting tests.
  let suiteSize = 0;
  for (const file of walk(TESTS_DIR)) {
    const source = readFileSync(file, 'utf8');
    suiteSize += (source.match(/\btest\s*(\.\w+)?\s*\(/g) ?? []).length;
  }
  const cap = Math.max(MIN_CAP, Math.ceil(suiteSize * CAP_FRACTION));
  if (rows.length > cap) {
    problems.push(
      `${rows.length} tests quarantined, cap is ${cap} (max(${MIN_CAP}, ${CAP_FRACTION * 100}% of ~${suiteSize} tests)). ` +
        'Past this point the gate is not meaningfully gating.',
    );
  }
} else {
  notes.push(`No ${TESTS_DIR}/ directory yet — skipping the code-vs-list reconciliation. The list itself was still validated.`);
}

// --- report -----------------------------------------------------------------
console.log(`Quarantine audit: ${rows.length} listed entr${rows.length === 1 ? 'y' : 'ies'}, ${taggedInCode} @quarantine tag(s) in code.`);

for (const note of notes) console.log(`::notice::${note}`);

if (problems.length > 0) {
  for (const problem of problems) console.log(`::error::${problem}`);
  console.error(`\nQuarantine audit FAILED with ${problems.length} violation(s). Policy: ${LIST_PATH}`);
  process.exit(1);
}

console.log('Quarantine audit passed.');
