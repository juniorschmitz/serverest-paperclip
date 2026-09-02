/**
 * Bounded retry for *transport* failures during worker setup.
 *
 * Read the scope carefully, because this file is the kind that grows into a
 * flake-hiding machine if it is allowed to:
 *
 *   It retries only errors where no HTTP response was ever received —
 *   ECONNRESET, ETIMEDOUT, socket hang up. A request that got an answer, even a
 *   500, is never retried: that is a result, and results belong to assertions.
 *
 *   It is used only by worker setup (fetching swagger.json), not by test
 *   requests. A transient reset while fetching an immutable document should not
 *   destroy a whole worker's run. A transient reset during the operation under
 *   test is a finding, and hiding it would be the exact failure this suite is
 *   supposed to prevent.
 *
 * Context: the client's machines are behind a Zscaler TLS-inspecting proxy that
 * occasionally resets the first connection of a process. CI runners are not
 * behind it and will never take this path.
 */

const TRANSPORT_ERRORS = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'socket hang up',
  'socket disconnected',
];

function isTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSPORT_ERRORS.some((needle) => message.includes(needle));
}

export interface TransportRetryOptions {
  attempts?: number;
  /** Base delay; doubled each attempt. */
  delayMs?: number;
  /** Shown in the warning so it is obvious what retried and why. */
  label: string;
}

export async function withTransportRetry<T>(
  operation: () => Promise<T>,
  { attempts = 3, delayMs = 500, label }: TransportRetryOptions,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransportFailure(error) || attempt === attempts) throw error;

      const wait = delayMs * 2 ** (attempt - 1);
      // Always logged. A retry that happens silently is a retry that hides a
      // deteriorating network from whoever reads the run afterwards.
      // eslint-disable-next-line no-console
      console.warn(
        `[transport] ${label} failed with a connection-level error ` +
          `(${error instanceof Error ? error.message : String(error)}); ` +
          `attempt ${attempt}/${attempts}, retrying in ${wait}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  throw lastError;
}
