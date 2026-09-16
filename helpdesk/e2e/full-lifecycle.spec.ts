import { test, expect } from '@playwright/test';
import {
  USERS, login, switchUser, raiseRequest, openSupportDetail, openRequestDetail,
  setStatus, assignTo, assertNoInternalIds,
} from './helpers';

/**
 * The full happy-path status machine driven through the UI as support:
 *   NEW → TRIAGE → ACCEPTED → ASSIGNED → ACTIVE → COMPLETE
 * plus the reject branch (TRIAGE → REJECTED) on a second request, verifying the
 * status control only offers legal transitions at each step.
 */

const RUN = Date.now();
const TEAM = 'Service Desk';
const TASK = 'Unlock User Account';

test.describe('Full status lifecycle', () => {
  const happyTitle = `E2E Full lifecycle ${RUN}`;

  test('requester raises the request', async ({ page }) => {
    await login(page, USERS.requester.username);
    await raiseRequest(page, { team: TEAM, task: TASK, title: happyTitle });
    await expect(page.locator('.info-row', { hasText: 'Status' })).toContainText('NEW');
  });

  test('support drives NEW → TRIAGE → ACCEPTED → ASSIGNED → ACTIVE → COMPLETE', async ({ page }) => {
    await switchUser(page, USERS.support.username);
    await openSupportDetail(page, happyTitle);

    await setStatus(page, 'TRIAGE');
    await setStatus(page, 'ACCEPTED');
    // ASSIGNED is the next legal step; assign a member then move to ASSIGNED.
    await assignTo(page, USERS.support.name);
    await setStatus(page, 'ASSIGNED');
    await setStatus(page, 'ACTIVE');
    await setStatus(page, 'COMPLETE');

    // Closed: no further transitions offered.
    await expect(page.locator('.detail-header .status-pill')).toContainText('COMPLETE');
    await expect(page.getByText(/no status changes are available/i)).toBeVisible();
    assertNoInternalIds(await page.locator('body').innerText());
  });

  test('requester sees the completed status', async ({ page }) => {
    await switchUser(page, USERS.requester.username);
    await openRequestDetail(page, happyTitle, { includeComplete: true });
    await expect(page.locator('.info-row', { hasText: 'Status' })).toContainText('COMPLETE');
  });

  test('reject branch: TRIAGE → REJECTED', async ({ page }) => {
    const rejectTitle = `E2E Reject branch ${RUN}`;
    await login(page, USERS.requester.username);
    await raiseRequest(page, { team: TEAM, task: TASK, title: rejectTitle });

    await switchUser(page, USERS.support.username);
    await openSupportDetail(page, rejectTitle);
    await setStatus(page, 'TRIAGE');
    // REJECTED is offered from TRIAGE.
    await setStatus(page, 'REJECTED');
    await expect(page.getByText(/no status changes are available/i)).toBeVisible();
  });
});
