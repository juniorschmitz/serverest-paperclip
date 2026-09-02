import type { Page } from '@playwright/test';
import { config } from '@/config/env';

/**
 * Page-object base.
 *
 * A page object here owns two things and nothing else: how to reach the page,
 * and named locators for the things on it. It does not assert. Assertions live
 * in tests, so that a test reads as its own specification and a page object can
 * be reused by a test that expects failure.
 *
 * Selector policy is enforced by construction: subclasses build locators from
 * `getByTestId`, which resolves to the app's own `data-testid` attributes.
 * See docs/selector-strategy.md for why, and for the escape hatches.
 */
export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  /** Route path this page lives at, e.g. "/cadastrarusuarios". */
  abstract readonly path: string;

  /** Navigate straight here. Faster and less brittle than clicking through. */
  async goto(): Promise<void> {
    await this.page.goto(config().uiBaseUrl + this.path, { waitUntil: 'domcontentloaded' });
  }

  /** Current path, for asserting navigation happened. */
  currentPath(): string {
    return new URL(this.page.url()).pathname;
  }
}
