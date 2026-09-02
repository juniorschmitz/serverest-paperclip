import type { APIRequestContext } from '@playwright/test';
import type { Credentials } from '@/data/factories';
import { config } from '@/config/env';

/**
 * Token lifecycle.
 *
 * The JWT this API issues lives for exactly 600 seconds — measured, `iat` to
 * `exp`. A suite that mints one token in global setup and shares it starts
 * failing about ten minutes in, and those failures land on whichever test
 * happened to be running. That is the worst possible failure mode: it looks
 * like flake, it moves around between runs, and it destroys trust in the suite.
 *
 * So: no shared token, no global-setup capture, no storage state on disk.
 * Each worker owns a TokenManager. It mints lazily, caches per identity, and
 * re-mints when the token is inside the refresh margin. Test authors never see
 * any of it — they ask an ApiClient for a request and get a valid token.
 *
 * The margin (default 120s of a 600s life) covers clock skew between this
 * machine and the server, plus the duration of a long test. Belt and braces:
 * ApiClient also retries once on a 401 that names an expired token, so a token
 * that dies mid-flight self-heals rather than failing a test.
 */

interface CachedToken {
  /** Full header value, i.e. "Bearer eyJ...". */
  readonly header: string;
  /** Absolute expiry from the token's own `exp` claim, in epoch ms. */
  readonly expiresAtMs: number;
  /**
   * The lifetime the server itself declared: `exp - iat`.
   *
   * Kept separately from `expiresAtMs` because this one is pure server-side
   * arithmetic and involves no local clock. Comparing `exp` against
   * `Date.now()` mixes two clocks that are not synchronised — that difference
   * showed up as a token appearing to have 601 seconds of a 600-second life
   * left, which failed a test that had no business depending on clock
   * agreement in the first place.
   */
  readonly declaredTtlSeconds: number | undefined;
}

export interface TokenStats {
  mints: number;
  refreshes: number;
}

/** Decode a JWT payload without verifying it — we only need `iat` and `exp`. */
function readClaims(jwt: string): { iat?: number; exp?: number } {
  const payload = jwt.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as {
      iat?: number;
      exp?: number;
    };
  } catch {
    return {};
  }
}

export class TokenManager {
  private readonly cache = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, Promise<CachedToken>>();
  readonly stats: TokenStats = { mints: 0, refreshes: 0 };

  constructor(
    private readonly request: APIRequestContext,
    private readonly apiBaseUrl: string = config().apiBaseUrl,
    private readonly marginMs: number = config().tokenRefreshMarginMs,
  ) {}

  /**
   * The `Authorization` header value for these credentials, minting or
   * refreshing as needed. Safe to call on every single request.
   */
  async authHeader(creds: Credentials): Promise<string> {
    const key = creds.email.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && !this.isStale(cached)) return cached.header;
    if (cached) this.stats.refreshes += 1;

    // Collapse concurrent requests for the same identity into one login, so a
    // test making parallel calls does not mint four tokens.
    const existing = this.inFlight.get(key);
    if (existing) return (await existing).header;

    const pending = this.mint(creds).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    const token = await pending;
    this.cache.set(key, token);
    return token.header;
  }

  /**
   * Drop a cached token so the next call re-mints. Called by ApiClient when the
   * server rejects a token we believed was live.
   */
  invalidate(creds: Credentials): void {
    this.cache.delete(creds.email.toLowerCase());
  }

  /**
   * Seconds of life left on the cached token, measured against the *local*
   * clock. Fine for diagnostics and for the refresh decision; do not assert a
   * tight bound on it, because it carries the skew between this machine and the
   * server.
   */
  secondsRemaining(creds: Credentials): number | undefined {
    const cached = this.cache.get(creds.email.toLowerCase());
    if (!cached) return undefined;
    return Math.round((cached.expiresAtMs - Date.now()) / 1000);
  }

  /**
   * The lifetime the server declared for this token (`exp - iat`).
   *
   * Clock-independent, so this is the value to assert on when the thing under
   * test is the TTL itself.
   */
  declaredTtlSeconds(creds: Credentials): number | undefined {
    return this.cache.get(creds.email.toLowerCase())?.declaredTtlSeconds;
  }

  private isStale(token: CachedToken): boolean {
    return Date.now() >= token.expiresAtMs - this.marginMs;
  }

  private async mint(creds: Credentials): Promise<CachedToken> {
    const res = await this.request.post(`${this.apiBaseUrl}/login`, { data: creds });
    const body = (await res.json().catch(() => ({}))) as { authorization?: string; message?: string };

    if (res.status() !== 200 || !body.authorization) {
      throw new Error(
        `Could not mint a token for ${creds.email}: POST /login returned ${res.status()} ` +
          `${JSON.stringify(body)}. The identity was probably never created, or the shared ` +
          `sandbox was reset mid-run.`,
      );
    }

    this.stats.mints += 1;
    const jwt = body.authorization.replace(/^Bearer\s+/i, '');
    const { iat, exp } = readClaims(jwt);

    return {
      header: `Bearer ${jwt}`,
      expiresAtMs: exp !== undefined ? exp * 1000 : Date.now() + 600_000,
      declaredTtlSeconds: exp !== undefined && iat !== undefined ? exp - iat : undefined,
    };
  }
}
