import { test, expect } from '@playwright/test';
import {
  USERS, login, switchUser, raiseRequest, openSupportDetail, setStatus, assignTo,
} from './helpers';

/**
 * Timer flow (R8): a support member working an ACTIVE request clicks
 * "Working on It" (start timer), then "Back to Queue" (stop) which opens the
 * duration pop-up; confirming records the time and the "(Working On)" marker
 * clears.
 */

const RUN = Date.now();
const TEAM = 'Service Desk';
const TASK = 'Unlock User Account';

test.describe('Support timer', () => {
  test('start "Working on It" then stop and record the duration', async ({ page }) => {
    const title = `E2E Timer ${RUN}`;
    await login(page, USERS.requester.username);
    await raiseRequest(page, { team: TEAM, task: TASK, title });

    await switchUser(page, USERS.support.username);
    await openSupportDetail(page, title);

    // Move the request to ACTIVE so the timer is available.
    await setStatus(page, 'TRIAGE');
    await setStatus(page, 'ACCEPTED');
    await assignTo(page, USERS.support.name);
    await setStatus(page, 'ASSIGNED');
    await setStatus(page, 'ACTIVE');

    // Start the timer.
    await page.getByRole('button', { name: /working on it/i }).click();
    // The header shows the "(Working On)" marker and a "Back to Queue" control.
    await expect(page.getByRole('button', { name: /back to queue/i })).toBeVisible();
    await expect(page.locator('.detail-header')).toContainText(/working on/i);

    // Stop → duration pop-up appears; confirm to record.
    await page.getByRole('button', { name: /back to queue/i }).click();
    const modal = page.locator('.modal-overlay');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: /confirm/i }).click();

    // Timer cleared: "Working on It" is offered again (still ACTIVE, no open timer).
    await expect(page.getByRole('button', { name: /working on it/i })).toBeVisible();
  });
});
