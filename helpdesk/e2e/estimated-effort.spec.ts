import { test, expect } from '@playwright/test';
import { USERS, login } from './helpers';

/**
 * Estimated Effort column (R4.7): a request whose task type has COMPLETE
 * requests with recorded time shows a type-level average effort (not blank).
 * The seed guarantees several such types (e.g. Unlock User Account ~75m).
 */

test.describe('Estimated Effort column', () => {
  test('shows a type-level average for a type with completed history', async ({ page }) => {
    await login(page, USERS.support.username);
    // The Support team queue shows Service Desk requests; Unlock User Account
    // and PC Hung types have completed history in the seed.
    await page.goto('/support');
    await page.getByRole('button', { name: /team queue/i }).click();
    await page.getByRole('searchbox', { name: /search queue/i }).fill('Unlock User Account');

    const rows = page.locator('tr.request-row');
    await expect(rows.first()).toBeVisible();

    // At least one row's Est. Effort cell is populated (not the em-dash).
    // The Est. Effort is the 11th column (index 10) after the Updated column
    // was removed. Read the row text and assert a duration token appears.
    const anyEffort = await rows.evaluateAll((trs) =>
      trs.some((tr) => {
        const cells = tr.querySelectorAll('td');
        const effort = cells[cells.length - 1]?.textContent?.trim() ?? '';
        return /\d+\s*(m|h|d)/.test(effort);
      }),
    );
    expect(anyEffort).toBe(true);
  });
});
