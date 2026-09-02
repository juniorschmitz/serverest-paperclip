import { ENVIRONMENTS, FORBIDDEN_HOSTS, type EnvironmentConfig } from './environments';

/** Everything the suite needs to know about where and how it is running. */
export interface ResolvedConfig extends EnvironmentConfig {
  readonly envKey: string;
  readonly emailDomain: string;
  readonly runId: string;
  readonly tokenRefreshMarginMs: number;
  readonly strictCleanup: boolean;
  readonly strictContract: boolean;
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    throw new Error(`Not a valid URL: "${url}"`);
  }
}

/**
 * Refuse to run against anything on the denylist.
 *
 * Exact-host match, not substring: compassuol.serverest.dev is a different host
 * from serverest.dev and must stay allowed.
 */
function assertNotForbidden(label: string, url: string): void {
  const host = hostOf(url);
  if (FORBIDDEN_HOSTS.some((forbidden) => host === forbidden.toLowerCase())) {
    throw new Error(
      `Refusing to run: ${label} resolves to "${host}", which is on the forbidden-host list ` +
        `(src/config/environments.ts). Testing against it is not authorised.`,
    );
  }
}

let cached: ResolvedConfig | undefined;

/** Resolve the run configuration. Memoised per process (one process per worker). */
export function config(): ResolvedConfig {
  if (cached) return cached;

  const envKey = str('TEST_ENV', 'staging');
  const base = ENVIRONMENTS[envKey];
  if (!base) {
    throw new Error(
      `Unknown TEST_ENV "${envKey}". Known: ${Object.keys(ENVIRONMENTS).join(', ')}. ` +
        `Add a block to src/config/environments.ts rather than hardcoding a URL in a test.`,
    );
  }

  const apiBaseUrl = stripTrailingSlash(str('API_BASE_URL', base.apiBaseUrl));
  const uiBaseUrl = stripTrailingSlash(str('UI_BASE_URL', base.uiBaseUrl));
  const uiHardcodedApiOrigin = stripTrailingSlash(
    str('UI_HARDCODED_API_ORIGIN', base.uiHardcodedApiOrigin),
  );

  assertNotForbidden('API_BASE_URL', apiBaseUrl);

  cached = {
    ...base,
    envKey,
    apiBaseUrl,
    uiBaseUrl,
    uiHardcodedApiOrigin,
    rewriteUiOrigin: bool('UI_REWRITE_ORIGIN', base.rewriteUiOrigin),
    emailDomain: str('TEST_EMAIL_DOMAIN', 'qa.testcia.dev'),
    runId: str('TEST_RUN_ID', 'local'),
    tokenRefreshMarginMs: int('TOKEN_REFRESH_MARGIN_SECONDS', 120) * 1000,
    strictCleanup: bool('STRICT_CLEANUP', false),
    strictContract: bool('STRICT_CONTRACT', false),
  };

  return cached;
}
