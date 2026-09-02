/**
 * Teardown bookkeeping.
 *
 * Nothing in the sandbox may be assumed to exist, so every test creates what it
 * needs; the corollary is that every test must remove what it created, or the
 * shared instance fills up with our litter and duplicate-name constraints start
 * failing tests that are actually fine.
 *
 * Two properties matter and both are easy to get wrong:
 *
 *   Teardown runs even when the test fails. Playwright guarantees this for code
 *   after `await use()` in a fixture, which is why cleanup lives in a fixture
 *   and never in the test body.
 *
 *   Deletion is ordered. The API enforces referential rules — a product in
 *   somebody's cart cannot be deleted, and a user who owns a cart cannot be
 *   deleted. So carts go first, then products, then users. Within a kind,
 *   newest first.
 *
 * Failures here are collected and reported, never thrown by default: a cleanup
 * error thrown from teardown would overwrite the real reason the test failed,
 * which is the single most annoying thing a suite can do to whoever is
 * debugging it. Set STRICT_CLEANUP=true in a nightly job to make leaks loud.
 */

/** Deletion order is the order of this list. */
const ORDER = ['carrinho', 'produto', 'usuario'] as const;

export type ResourceKind = (typeof ORDER)[number];

interface Entry {
  kind: ResourceKind;
  label: string;
  dispose: () => Promise<void>;
}

export interface CleanupFailure {
  label: string;
  reason: string;
}

export interface CleanupReport {
  attempted: number;
  deleted: number;
  failures: CleanupFailure[];
}

export class ResourceRegistry {
  private readonly entries: Entry[] = [];

  /**
   * Register something to delete at the end of the test.
   * `label` shows up in the cleanup warning, so make it identifiable —
   * "usuario dGk3 (testcia.local-3f9a12-001@qa.testcia.dev)".
   */
  track(kind: ResourceKind, label: string, dispose: () => Promise<void>): void {
    this.entries.push({ kind, label, dispose });
  }

  /** What is still registered, for assertions about the registry itself. */
  get pending(): ReadonlyArray<{ kind: ResourceKind; label: string }> {
    return this.entries.map(({ kind, label }) => ({ kind, label }));
  }

  /** Delete everything, in dependency order. Never throws. */
  async dispose(): Promise<CleanupReport> {
    const report: CleanupReport = { attempted: this.entries.length, deleted: 0, failures: [] };

    for (const kind of ORDER) {
      const ofKind = this.entries.filter((e) => e.kind === kind).reverse();
      for (const entry of ofKind) {
        try {
          await entry.dispose();
          report.deleted += 1;
        } catch (error) {
          report.failures.push({
            label: `${entry.kind} ${entry.label}`,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    this.entries.length = 0;
    return report;
  }
}
