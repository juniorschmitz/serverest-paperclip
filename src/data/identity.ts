import { randomBytes } from 'node:crypto';
import { config } from '@/config/env';

/**
 * Unique-value generation for a shared sandbox.
 *
 * The instance under test is public: other people are creating users and
 * products in it while we run, and our own workers run in parallel processes.
 * Two constraints follow, both enforced by the API:
 *
 *   - user email must be unique   (POST /usuarios -> 400 "Este email já está sendo usado")
 *   - product name must be unique (POST /produtos -> 400 "Já existe produto com esse nome")
 *
 * A collision on either produces a failure that looks like a product bug and is
 * not one. So every generated value carries three independent sources of
 * uniqueness:
 *
 *   runId     correlates a whole run; CI sets TEST_RUN_ID to the build id
 *   procId    6 random hex chars, generated once per worker process
 *   seq       monotonic counter within the process
 *
 * procId alone is enough to prevent collisions. runId and seq are there to make
 * a stray record in the sandbox traceable back to the run that leaked it.
 */

/** Stable for the life of this worker process. Workers are separate processes. */
const PROC_ID = randomBytes(3).toString('hex');

let seq = 0;

function nextSeq(): string {
  seq += 1;
  return String(seq).padStart(3, '0');
}

/** e.g. "local-3f9a12-007" — safe in an email local part, a name, or a slug. */
export function uniqueToken(): string {
  return `${config().runId}-${PROC_ID}-${nextSeq()}`.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * A unique, syntactically valid email.
 *
 * The API validates the address: dotted local parts and a real TLD are fine,
 * but reserved-looking TLDs such as `.local` are rejected with
 * "email deve ser um email válido". TEST_EMAIL_DOMAIN defaults to a domain that
 * identifies our data to anyone else using the sandbox.
 */
export function uniqueEmail(prefix = 'testcia'): string {
  return `${prefix}.${uniqueToken()}@${config().emailDomain}`.toLowerCase();
}

/** A unique human-readable name, e.g. "Produto Teste local-3f9a12-007". */
export function uniqueName(prefix: string): string {
  return `${prefix} ${uniqueToken()}`;
}

/** Exposed for diagnostics — printed in the run banner. */
export function processIdentity(): { runId: string; procId: string } {
  return { runId: config().runId, procId: PROC_ID };
}
