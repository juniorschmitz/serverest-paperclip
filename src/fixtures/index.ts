/**
 * The one import a test file needs:
 *
 *   import { test, expect } from '@/fixtures';
 *
 * Importing `test` from '@playwright/test' directly skips the fixture layer,
 * and with it token refresh, seeding and cleanup. Don't.
 */
export { test, expect, type Actor, type TestFixtures, type WorkerFixtures } from './test';
