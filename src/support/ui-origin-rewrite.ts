import { expect, type Page, type Route } from '@playwright/test';

/**
 * Point the shipped front-end at our backend.
 *
 * The problem: front.serverest.dev is the only ServeRest UI that exists, and
 * its bundle has `https://serverest.dev` compiled in — a different instance
 * from the one under test. Verified by reading the bundle: exactly one API
 * origin appears in it, and there is no runtime environment variable to change
 * it. Run as shipped, a UI test would pass or fail based on somebody else's
 * backend and tell us nothing about ours.
 *
 * The fix: intercept every request the page makes to that origin and satisfy it
 * from ours instead.
 *
 * Why fetch-and-fulfill rather than `route.continue({ url })`:
 *
 *   `continue` hands the rewritten URL back to the browser, which then applies
 *   its own CORS rules to a cross-origin response the page never asked for.
 *   `route.fetch()` performs the request from Node — no browser CORS involved —
 *   and `route.fulfill()` returns the result as the answer to the original
 *   request. The page believes it talked to the origin it asked for, so the
 *   same-origin bookkeeping stays consistent, and we get the response body in
 *   hand for logging.
 *
 * Two headers have to be corrected on the way back. `content-encoding` and
 * `content-length` describe the wire form of the upstream response, but
 * route.fetch has already decoded the body — passing them through makes the
 * browser try to gunzip plain JSON. `access-control-allow-origin` is forced to
 * `*` so the browser accepts the response regardless of what upstream sent;
 * the target already sends `*`, this just removes the dependency on it.
 *
 * CORS preflights: Chromium does not always surface OPTIONS preflights to a
 * route handler. When it does not, the preflight goes to the real hardcoded
 * origin, which answers `access-control-allow-origin: *`, the browser is
 * satisfied, and the actual request is then intercepted and rewritten as
 * normal. Correct either way — but note that it means a preflight OPTIONS may
 * reach the public instance. It carries no test data and mutates nothing.
 */

export interface RewriteRecord {
  method: string;
  /** URL the page asked for. */
  from: string;
  /** URL we actually served it from. */
  to: string;
  status: number;
}

export interface OriginRewriteOptions {
  /** Origin compiled into the bundle, e.g. "https://serverest.dev". */
  fromOrigin: string;
  /** Origin under test, e.g. "https://compassuol.serverest.dev". */
  toOrigin: string;
  /** Log each rewrite to stdout. Handy when debugging a UI test locally. */
  verbose?: boolean;
}

export interface OriginRewriteHandle {
  /** Every request that was redirected, in order. */
  readonly records: readonly RewriteRecord[];
  /**
   * Fail the test if the UI never actually talked to our backend.
   *
   * This is the assertion that makes the whole approach trustworthy. Without
   * it, a UI test could pass having silently reached the wrong instance — or
   * having reached nothing at all, if the bundle changes its API origin in a
   * future deploy and our matcher stops matching. Any UI test that exercises a
   * backend call should end with this.
   */
  assertRewroteApiTraffic(minimum?: number): void;
  /** Stop intercepting. Called automatically in fixture teardown. */
  dispose(): Promise<void>;
}

/** Headers that describe the upstream wire format and must not be replayed. */
const STRIPPED_HEADERS = ['content-encoding', 'content-length'];

export async function installOriginRewrite(
  page: Page,
  { fromOrigin, toOrigin, verbose = false }: OriginRewriteOptions,
): Promise<OriginRewriteHandle> {
  const records: RewriteRecord[] = [];
  const from = fromOrigin.replace(/\/+$/, '');
  const to = toOrigin.replace(/\/+$/, '');

  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    const original = request.url();
    const rewritten = to + original.slice(from.length);

    try {
      const upstream = await route.fetch({ url: rewritten, maxRedirects: 0 });

      const headers: Record<string, string> = { ...upstream.headers() };
      for (const key of STRIPPED_HEADERS) delete headers[key];
      headers['access-control-allow-origin'] = '*';
      headers['access-control-allow-headers'] = '*';
      headers['access-control-allow-methods'] = 'GET,POST,PUT,DELETE,OPTIONS';

      records.push({
        method: request.method(),
        from: original,
        to: rewritten,
        status: upstream.status(),
      });
      if (verbose) {
        // eslint-disable-next-line no-console
        console.log(`[rewrite] ${request.method()} ${original} -> ${rewritten} (${upstream.status()})`);
      }

      await route.fulfill({ response: upstream, headers });
    } catch (error) {
      // Aborting rather than swallowing: a silently dropped API call would show
      // up as a confusing UI assertion failure much later. This way the reason
      // is on the console and in the trace.
      // eslint-disable-next-line no-console
      console.error(
        `[rewrite] failed ${request.method()} ${original} -> ${rewritten}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      await route.abort('failed');
    }
  };

  // A predicate matcher rather than a glob: it is exact about the origin, and
  // it cannot accidentally catch the page's own assets from the UI host.
  //
  // Held in a variable because `unroute` matches a function matcher by
  // reference. Passing an equivalent-but-new arrow function to unroute would
  // silently fail to remove the route.
  const matcher = (url: URL): boolean => url.href.startsWith(`${from}/`) || url.href === from;

  await page.route(matcher, handler);

  return {
    records,
    assertRewroteApiTraffic(minimum = 1): void {
      expect(
        records.length,
        `The UI made no request to ${from}, so nothing was redirected to ${to} and this test ` +
          `proved nothing about the instance under test. Either the flow does not call the API, ` +
          `or the bundle's hardcoded origin changed — re-check it and update ` +
          `UI_HARDCODED_API_ORIGIN. See docs/ui-origin-rewrite.md.`,
      ).toBeGreaterThanOrEqual(minimum);
    },
    async dispose(): Promise<void> {
      await page.unroute(matcher, handler);
    },
  };
}
