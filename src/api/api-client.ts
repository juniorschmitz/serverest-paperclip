import { test, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { Credentials } from '@/data/factories';
import type { ContractValidator } from '@/support/contract';
import { config } from '@/config/env';
import type { TokenManager } from './token-manager';

/**
 * The single path every API call takes.
 *
 * Responsibilities, in order:
 *   1. interpolate the path template and attach query params
 *   2. attach a fresh Authorization header, minted or refreshed on demand
 *   3. retry exactly once if the server says the token expired mid-flight
 *   4. validate the response against swagger.json
 *   5. return a typed result that does not tempt the caller into a flaky assertion
 *
 * Authorization is attached per *request*, not baked into the request context.
 * Playwright's `extraHTTPHeaders` is fixed when the context is created, which
 * would freeze one token for the life of the worker — precisely the thing that
 * breaks against a 600-second TTL.
 */

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, string>;
  /** "POST /usuarios" — the templated operation, for messages and reporting. */
  operation: string;
  /** Contract check outcome. `documented: false` means the spec is silent on this status. */
  contract: { documented: boolean; ok: boolean; errors: string[] };
}

export interface SendOptions {
  pathParams?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  /**
   * Send this exact Authorization header instead of a managed token. This is
   * how token-negative tests send a malformed, foreign or expired token — and
   * it also disables the auto-retry, so a deliberate 401 stays a 401.
   */
  rawAuthorization?: string;
  /** Skip contract validation. Only for responses that are not JSON. */
  skipContract?: boolean;
}

type Method = 'get' | 'post' | 'put' | 'delete';

export class ApiClient {
  constructor(
    private readonly request: APIRequestContext,
    private readonly tokens: TokenManager,
    private readonly contract: ContractValidator,
    private readonly credentials?: Credentials,
    private readonly baseUrl: string = config().apiBaseUrl,
  ) {}

  /** A client authenticated as someone else. Used for privilege-boundary tests. */
  as(credentials: Credentials): ApiClient {
    return new ApiClient(this.request, this.tokens, this.contract, credentials, this.baseUrl);
  }

  /** A client that sends no Authorization header at all. */
  anonymous(): ApiClient {
    return new ApiClient(this.request, this.tokens, this.contract, undefined, this.baseUrl);
  }

  /** Who this client authenticates as, if anyone. */
  get identity(): Credentials | undefined {
    return this.credentials;
  }

  get tokenManager(): TokenManager {
    return this.tokens;
  }

  get<T = unknown>(path: string, opts: SendOptions = {}): Promise<ApiResponse<T>> {
    return this.send<T>('get', path, opts);
  }

  post<T = unknown>(path: string, opts: SendOptions = {}): Promise<ApiResponse<T>> {
    return this.send<T>('post', path, opts);
  }

  put<T = unknown>(path: string, opts: SendOptions = {}): Promise<ApiResponse<T>> {
    return this.send<T>('put', path, opts);
  }

  delete<T = unknown>(path: string, opts: SendOptions = {}): Promise<ApiResponse<T>> {
    return this.send<T>('delete', path, opts);
  }

  async send<T = unknown>(
    method: Method,
    template: string,
    opts: SendOptions = {},
  ): Promise<ApiResponse<T>> {
    const operation = `${method.toUpperCase()} ${template}`;

    // A test step per call: the HTML report and the trace both become readable
    // as a list of API operations instead of an undifferentiated wall of calls.
    return test.step(operation, async () => {
      const managed = opts.rawAuthorization === undefined && this.credentials !== undefined;

      let response = await this.dispatch(method, template, opts);

      // The token died between our staleness check and the server reading it —
      // clock skew, or a test that ran long. Re-mint once and repeat. Only for
      // managed tokens: a test that deliberately sent a bad one must keep its 401.
      if (managed && response.status() === 401 && (await namesExpiredToken(response))) {
        this.tokens.invalidate(this.credentials!);
        response = await this.dispatch(method, template, opts);
      }

      const status = response.status();
      const body = (await parseJson(response)) as T;
      const check = opts.skipContract
        ? { documented: false, ok: true, errors: [] }
        : this.contract.validate(method, template, status, body);

      if (!check.ok) {
        const detail = `${operation} -> ${status} does not match swagger.json: ${check.errors.join('; ')}`;
        if (config().strictContract) throw new Error(detail);
        // eslint-disable-next-line no-console
        console.warn(`[contract] ${detail}`);
      }

      return {
        status,
        body,
        headers: response.headers(),
        operation,
        contract: { documented: check.documented, ok: check.ok, errors: check.errors },
      };
    });
  }

  private async dispatch(
    method: Method,
    template: string,
    opts: SendOptions,
  ): Promise<APIResponse> {
    const url = this.baseUrl + interpolate(template, opts.pathParams);
    const headers: Record<string, string> = {};

    if (opts.rawAuthorization !== undefined) {
      headers['Authorization'] = opts.rawAuthorization;
    } else if (this.credentials) {
      headers['Authorization'] = await this.tokens.authHeader(this.credentials);
    }

    return this.request.fetch(url, {
      method: method.toUpperCase(),
      headers,
      params: opts.query,
      ...(opts.body === undefined ? {} : { data: opts.body }),
      // Never throw on a non-2xx: negative cases are first-class here.
      failOnStatusCode: false,
    });
  }
}

function interpolate(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(
        `Path template "${template}" needs a "${key}" param but none was given. ` +
          `Pass it as pathParams: { ${key}: '...' }.`,
      );
    }
    return encodeURIComponent(value);
  });
}

async function parseJson(response: APIResponse): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON — an HTML error page from the edge, say. Hand the caller the raw
    // text rather than throwing, so the test can assert on what it actually got.
    return text;
  }
}

/** ServeRest's expiry message, matched loosely so wording changes do not break it. */
async function namesExpiredToken(response: APIResponse): Promise<boolean> {
  const body = (await response.text().catch(() => '')).toLowerCase();
  return body.includes('expirado') || body.includes('expired');
}
