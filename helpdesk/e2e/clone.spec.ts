import { test, expect } from '@playwright/test';
import { USERS, login, raiseRequest, openRequestDetail } from './helpers';

/**
 * Clone flow (R5.8): cloning a request opens the New workflow at Step 2 with the
 * original's values pre-filled, and submitting creates a distinct new request.
 */

const RUN = Date.now();
const TEAM = 'Service Desk';
const TASK = 'Password Reset';

test.describe('Clone a request', () => {
  const original = `E2E Clone source ${RUN}`;

  test('clone pre-fills Step 2 and creates a new request', async ({ page }) => {
    await login(page, USERS.requester.username);
    const originalId = await raiseRequest(page, {
      team: TEAM, task: TASK, title: original, jira: 'JIRA-CLONE-1',
    });

    // From the detail, click Clone → lands in the New workflow at Step 2.
    await openRequestDetail(page, original);
    await page.getByRole('button', { name: /^Clone$/ }).click();
    await page.waitForURL(/\/new$/);

    // Step 2 is shown with the title pre-filled from the source.
    await expect(page.locator('#request-title')).toBeVisible();
    await expect(page.locator('#request-title')).toHaveValue(original);
    // Jira carried over too.
    await expect(page.locator('#request-jira')).toHaveValue('JIRA-CLONE-1');

    // Give the clone a distinct title, submit, and confirm a NEW request id.
    const cloneTitle = `E2E Clone copy ${RUN}`;
    await page.fill('#request-title', cloneTitle);
    await page.getByRole('button', { name: /^Next$/ }).click();
    await page.getByRole('button', { name: /^Submit$/ }).click();
    await page.waitForURL(/\/requests\/\d+$/);

    const newId = Number(page.url().match(/\/requests\/(\d+)$/)![1]);
    expect(newId).not.toBe(originalId);
    await expect(page.getByRole('heading', { name: cloneTitle })).toBeVisible();
  });
});
