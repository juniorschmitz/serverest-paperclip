/**
 * Environment definitions.
 *
 * Adding an environment is a data change here, never a code change in a test.
 * Anything in this file can also be overridden per-value by an env var at run
 * time (see env.ts), so CI can point the suite somewhere new with variables
 * alone.
 */

export interface EnvironmentConfig {
  /** Human name, shown in the run banner and report metadata. */
  readonly name: string;
  /** Origin of the ServeRest API under test. No trailing slash, no /api prefix. */
  readonly apiBaseUrl: string;
  /** Origin serving the ServeRest front-end. */
  readonly uiBaseUrl: string;
  /**
   * The API origin the shipped UI bundle has compiled in. When this differs
   * from apiBaseUrl the UI is talking to the wrong backend and the fixture
   * layer rewrites it at the network layer.
   */
  readonly uiHardcodedApiOrigin: string;
  /** Whether to install that rewrite. False when the UI already points at apiBaseUrl. */
  readonly rewriteUiOrigin: boolean;
}

export const ENVIRONMENTS: Record<string, EnvironmentConfig> = {
  /**
   * The client's instance. This is the only environment the suite runs against
   * today. It is a shared public sandbox — see docs/shared-sandbox-rules.md.
   */
  staging: {
    name: 'staging (CompassUOL)',
    apiBaseUrl: 'https://compassuol.serverest.dev',
    uiBaseUrl: 'https://front.serverest.dev',
    // front.serverest.dev ships with https://serverest.dev compiled into its
    // bundle. Verified by reading the bundle, not assumed.
    uiHardcodedApiOrigin: 'https://serverest.dev',
    rewriteUiOrigin: true,
  },

  /**
   * A ServeRest + front-end pair running on the developer's machine
   * (docker run -p 3000:3000 paulogoncalvesbh/serverest). Present so the suite
   * is provably environment-portable; no rewrite needed because a locally built
   * front-end can be given the right API base at build time.
   */
  local: {
    name: 'local (docker)',
    apiBaseUrl: 'http://localhost:3000',
    uiBaseUrl: 'http://localhost:3001',
    uiHardcodedApiOrigin: 'http://localhost:3000',
    rewriteUiOrigin: false,
  },
};

/**
 * Hosts the suite must never touch. ServeRest has no production instance, but
 * the guard is here on purpose: the engagement rule is "never test against
 * production", and a rule that lives only in a document eventually gets broken
 * by a stray environment variable.
 *
 * Add real production hostnames here when the client's own app arrives.
 */
export const FORBIDDEN_HOSTS: readonly string[] = ['serverest.dev'];
