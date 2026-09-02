import { expect } from '@playwright/test';
import type { ApiResponse } from '@/api/api-client';

/**
 * Shared assertions.
 *
 * These exist mainly to make the flaky assertion harder to reach than the
 * stable one. On a shared instance the tempting assertion — "the list now has
 * 4 users" — is wrong, because somebody else is adding and removing users
 * while we run. The correct assertion is always about *our* record: is it in
 * the list, and is it the shape we expect?
 */

/** Assert a status with the response body in the failure message. */
export function expectStatus(res: ApiResponse<unknown>, expected: number): void {
  expect(
    res.status,
    `${res.operation} -> expected ${expected}, got ${res.status}: ${JSON.stringify(res.body)}`,
  ).toBe(expected);
}

/**
 * Assert that a list response contains our record, by id.
 *
 * Use this in place of any assertion on `quantidade`. It is immune to other
 * tenants of the sandbox, to parallel workers, and to leftover data.
 */
export function expectListContains<T extends { _id: string }>(
  res: ApiResponse<unknown>,
  items: T[],
  id: string,
): T {
  const found = items.find((item) => item._id === id);
  expect(
    found,
    `${res.operation} did not contain ${id}. Got ${items.length} item(s) in this page: ` +
      `${items.map((i) => i._id).join(', ') || '(none)'}`,
  ).toBeDefined();
  return found as T;
}

/** The mirror of the above, for delete verification. */
export function expectListExcludes<T extends { _id: string }>(
  res: ApiResponse<unknown>,
  items: T[],
  id: string,
): void {
  expect(
    items.find((item) => item._id === id),
    `${res.operation} still contained ${id} after it should have been deleted`,
  ).toBeUndefined();
}

/**
 * Assert the response matched swagger.json.
 *
 * ApiClient already validates every response and warns; this turns the warning
 * into a hard assertion for a specific call, which is what a contract-focused
 * test wants. `requireDocumented` additionally fails when the spec says nothing
 * about this status — useful for proving the spec is complete, noisy otherwise.
 */
export function expectContract(
  res: ApiResponse<unknown>,
  { requireDocumented = false }: { requireDocumented?: boolean } = {},
): void {
  expect(
    res.contract.errors,
    `${res.operation} -> ${res.status} does not match its swagger.json schema`,
  ).toEqual([]);

  if (requireDocumented) {
    expect(
      res.contract.documented,
      `swagger.json documents no ${res.status} response for ${res.operation}. ` +
        `Either the spec is incomplete or the API returned an undocumented status.`,
    ).toBe(true);
  }
}
