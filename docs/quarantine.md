# Quarantine list

The visible list of tests that are **not** gating changes right now.

This file is the single source of truth. `scripts/quarantine-audit.mjs` parses
the table below on every CI run and **fails the build** if the list and the code
disagree, or if an entry has outstayed its welcome. That is what stops
quarantine from becoming a place tests go to die.

Governing policy: [`docs/flake-policy.md`](./flake-policy.md).

## Rules the audit enforces

| Rule | Limit |
| --- | --- |
| Max time in quarantine | **14 days** from `Quarantined` date |
| Max entries at once | **5** tests, or 2% of the suite, whichever is larger |
| Required fields | every column below must be filled |
| Must have an owner | a named person, not a team |
| Must have a tracking issue | a real issue identifier |

An entry past its `Review by` date fails the `setup` job. The fix is to resolve
the test — not to extend the date. Extending a date requires a note in the
`Reason` column saying why, and the Chief of Staff sign-off referenced there.

## How a test gets on this list

1. The nightly `reliability` workflow flags it as inconsistent across runs.
2. Triage (within one working day) confirms it is a flake and **not** a product bug.
3. Tag the test `@quarantine` in its spec, and add a row here in the same commit.
4. Open a tracking issue and reference it in the row.

Removing a test from quarantine: fix the cause, run
`npm run reliability -- --repeats 10 --grep '<test title>'`, confirm 100% pass,
then drop the `@quarantine` tag and delete the row — again, same commit.

## Current quarantine

<!-- QUARANTINE-TABLE-START -->

| Test | Project | Quarantined | Review by | Owner | Issue | Reason |
| --- | --- | --- | --- | --- | --- | --- |

<!-- QUARANTINE-TABLE-END -->

**Currently quarantined: 0 tests.**

The suite has not landed yet (TES-8), so nothing is or can be quarantined. The
mechanism is in place and enforced from the first run.

## Example row

Kept outside the table above so the audit does not read it as a live entry:

```
| checkout > completes purchase with a seeded cart | ui | 2026-09-02 | 2026-09-16 | Ada Lovelace | TES-42 | Cart total renders before the XHR settles ~1 in 8 runs; needs a state-based wait, not a timeout. |
```
