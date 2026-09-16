import { test, expect } from '@playwright/test';
import { USERS, login, switchUser, raiseRequest, findInRequests } from './helpers';

/**
 * Mixed-user visibility (R5.1 / R19): a request raised by one user is NOT
 * visible to an unrelated user's "My Requests", and opening it directly is
 * refused. (The requester and an unrelated requester have no manager link.)
 */

const RUN = Date.now();
const TEAM = 'Service Desk';
const TASK = 'Password Reset';

test.describe('Cross-user visibility', () => {
  test("an unrelated user cannot see another user's request", async ({ page }) => {
    const title = `E2E Visibility ${RUN}`;
    await login(page, USERS.requester.username);
    const id = await raiseRequest(page, { team: TEAM, task: TASK, title });

    // Raiser sees it in their own list.
    await findInRequests(page, title);

    // An unrelated requester does NOT see it in "My Requests".
    await switchUser(page, USERS.other.username);
    await page.goto('/requests');
    await page.getByRole('searchbox', { name: /search requests/i }).fill(title);
    await expect(page.locator('tr.request-row', { hasText: title })).toHaveCount(0);

    // Opening the detail directly is refused (forbidden → friendly error, no crash).
    await page.goto(`/requests/${id}`);
    await expect(page.locator('body')).not.toContainText(title);
    // A user-facing error is shown rather than the request content.
    await expect(page.locator('[role="alert"], .detail-error, .list-error, .error')).toBeVisible();
  });
});
