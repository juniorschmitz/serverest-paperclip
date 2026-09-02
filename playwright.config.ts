import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

const isCI = !!process.env['CI'];

export default defineConfig({
  testDir: './tests',

  // Every test seeds its own data and cleans up after itself, so nothing shares
  // state and full parallelism is safe. Uniqueness of generated identities is
  // what makes this true — see src/data/identity.ts.
  fullyParallel: true,
  workers: process.env['WORKERS'] ? Number(process.env['WORKERS']) : isCI ? 4 : 4,

  /**
   * Retries stay at zero, on purpose, in CI as well as locally.
   *
   * A retry converts a real intermittent defect into a green run, and the suite
   * stops being able to tell anyone the truth. The tools for flake here are
   * unique test data, no shared token, no assertions on global counts, and
   * web-first assertions — not a second attempt. If something needs a retry to
   * pass, that is a finding to investigate, and `npm run reliability` exists to
   * surface it before the test is committed.
   */
  retries: 0,

  forbidOnly: isCI,
  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    // For whoever wires this into CI: most systems read JUnit natively.
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],

  outputDir: 'test-results',

  use: {
    /**
     * Failure artifacts.
     *
     * `retain-on-failure` rather than `on-first-retry`, because retries are 0 —
     * with retries off, on-first-retry would capture nothing, ever. A failing
     * run therefore always leaves a trace, a video and a screenshot on disk;
     * `npx playwright show-trace test-results/<test>/trace.zip` replays it,
     * and the HTML report links all three from the failed test.
     */
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',

    actionTimeout: 15_000,
    navigationTimeout: 30_000,

    // The app annotates its own elements with data-testid, so getByTestId is
    // the primary selector for the whole suite. docs/selector-strategy.md.
    testIdAttribute: 'data-testid',
  },

  projects: [
    {
      name: 'api',
      testMatch: /.*\.api\.spec\.ts/,
      // No browser is launched for these: they run through Playwright's
      // request context, which is why the API layer is the fast feedback loop
      // and gets the coverage wherever it is sufficient.
      use: {},
    },
    {
      name: 'ui',
      testMatch: /.*\.ui\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        // The bundle registers no service worker today (checked), but blocking
        // them removes the one way a request could escape page.route() and
        // reach the wrong backend without us noticing.
        serviceWorkers: 'block',
      },
    },
  ],
});
