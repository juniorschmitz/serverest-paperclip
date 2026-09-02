# UI origin rewrite — spike result

**Verdict: it works. Proceed with route rewriting. The fallback is not needed.**

Proven by a real run, not by reasoning. `tests/smoke/register.ui.spec.ts` is the
spike, kept as a permanent regression guard.

## The problem

`front.serverest.dev` is the only ServeRest front-end that exists, and its
bundle has the API origin compiled in. Read directly from the shipped bundle:

```
$ curl -s https://front.serverest.dev/static/js/main.63e8c0e3.chunk.js \
    | grep -oE 'https?://[a-z.-]*serverest\.dev[^"]*' | sort -u
https://serverest.dev
```

Exactly one origin, and it is not the instance under test. There is no
`REACT_APP_*` or `baseURL` indirection in the bundle to repoint at runtime — the
grep for those comes back empty. So a UI test run against it as shipped would
exercise the public reference instance and tell us nothing about the client's.

## The approach

Load the UI from `front.serverest.dev`, intercept every request it makes to
`https://serverest.dev`, and serve it from `https://compassuol.serverest.dev`
instead. Implemented in `src/support/ui-origin-rewrite.ts` and installed
automatically by the `page` fixture, so no test can forget it.

**Fetch-and-fulfill, not `route.continue({ url })`.** `continue` hands the
rewritten URL to the browser, which then applies its own CORS rules to a
cross-origin response the page never asked for. `route.fetch()` performs the
request from Node — no browser CORS involved — and `route.fulfill()` returns the
result as the answer to the original request. The page believes it talked to the
origin it asked for, and we get the response in hand for logging.

Two headers are corrected on the way back:

- `content-encoding` and `content-length` are dropped. They describe the wire
  form of the upstream response, but `route.fetch` has already decoded the body;
  replaying them makes the browser try to gunzip plain JSON.
- `access-control-allow-origin` is forced to `*`. The target already sends `*`,
  so this only removes the dependency on it continuing to.

## Evidence

From the run (`DEBUG_REWRITE=1`, registering a user through the UI form):

```
[rewrite] POST https://serverest.dev/usuarios -> https://compassuol.serverest.dev/usuarios (201)
[rewrite] POST https://serverest.dev/login    -> https://compassuol.serverest.dev/login    (200)
[rewrite] GET  https://serverest.dev/usuarios -> https://compassuol.serverest.dev/usuarios (200)
  ok 1 [ui] › register.ui.spec.ts › a user registered in the UI lands on the instance under test (8.6s)
```

The write, the login and the read were all redirected, and the app behaved
normally throughout — it logged the new user in and rendered the admin
dashboard.

The test does not stop at "the UI worked". It asserts three things:

1. **A `POST /usuarios` was intercepted and went to the target**, returning 201.
2. **The user exists on `compassuol.serverest.dev`**, confirmed by an
   independent API call outside the browser.
3. **The user does *not* exist on `serverest.dev`**, confirmed by a read-only
   `GET /usuarios?email=...` against the public instance.

Point 3 is what makes the approach trustworthy. Presence on the target alone
would not distinguish "the rewrite worked" from "the rewrite did nothing and
both instances happen to contain this email". That control is the only place in
the suite that touches the public host, it writes nothing, and the suite cannot
be pointed at that host even deliberately: it is on `FORBIDDEN_HOSTS` in
`src/config/environments.ts` and `env.ts` refuses to start against it.

## Risks that were checked and cleared

| Risk | Finding |
|---|---|
| Service worker bypassing `page.route()` | The app serves a Workbox `service-worker.js`, but no registration call appears in either bundle. Belt and braces: the `ui` project sets `serviceWorkers: 'block'`. |
| CSP blocking the rewritten responses | No `Content-Security-Policy` header on any `front.serverest.dev` response. |
| CORS preflight not intercepted | Chromium does not always surface preflight `OPTIONS` to a route handler. When it does not, the preflight reaches the real hardcoded origin, which answers `access-control-allow-origin: *`, the browser is satisfied, and the actual request is intercepted and rewritten as normal. Correct either way. Worth knowing: this means a preflight `OPTIONS` may reach the public instance. It carries no test data and mutates nothing. |
| Absolute URLs in XHR outside the matched origin | The bundle contains exactly one API origin, so there is nothing else to match. `assertRewroteApiTraffic()` fails loudly if a future deploy changes it. |

## The guard that keeps this honest

The failure mode to fear is not the rewrite breaking loudly — it is the rewrite
breaking *silently*, leaving UI tests green against the wrong backend. So any UI
test that exercises a backend call ends with:

```ts
originRewrite.assertRewroteApiTraffic();
```

which fails with an explicit message if no request was redirected. If a future
front-end deploy changes the hardcoded origin, that assertion fails immediately
and the fix is one environment variable: `UI_HARDCODED_API_ORIGIN`.

## Fallback, not currently needed

If the rewrite ever becomes unworkable — the app adopts a service worker it
genuinely needs, or moves to a stricter CSP — the fallback is to build the
open-source front-end locally with the API base repointed and run against
`localhost`. The `local` environment block in `src/config/environments.ts`
already describes that shape with `rewriteUiOrigin: false`, so switching is a
configuration change rather than a rewrite of the UI layer.
