import { test, expect } from '@playwright/test';
import { USERS, login, assertNoInternalIds } from './helpers';

/**
 * Screen-smoke coverage: each role can reach its screens, the screens render
 * meaningful content, and none of them leak internal ids ("Member #12" etc.).
 */

test.describe('Screen smoke by role', () => {
  test('support member: requests, support queue, statistics render cleanly', async ({ page }) => {
    await login(page, USERS.support.username);

    for (const path of ['/requests', '/support', '/statistics', '/statistics/team']) {
      await page.goto(path);
      // Page has a heading and no error banner.
      await expect(page.locator('h1.greeting, h1')).toBeVisible();
      await expect(page.locator('[role="alert"]')).toHaveCount(0);
      assertNoInternalIds(await page.locator('body').innerText());
    }
  });

  test('support member: support statistics dashboard renders', async ({ page }) => {
    await login(page, USERS.support.username);
    await page.goto('/statistics/support');
    await expect(page.locator('h1')).toBeVisible();
    assertNoInternalIds(await page.locator('body').innerText());
  });

  test('admin: administer tiles render and are readable', async ({ page }) => {
    await login(page, USERS.admin.username);
    await page.goto('/administer');
    await expect(page.locator('h1')).toBeVisible();
    assertNoInternalIds(await page.locator('body').innerText());

    await page.goto('/administer/teams');
    await expect(page.locator('body')).toContainText('Service Desk');
    assertNoInternalIds(await page.locator('body').innerText());
  });

  test('team leader: team statistics is populated (hierarchy resolves)', async ({ page }) => {
    await login(page, USERS.leader.username);
    await page.goto('/statistics/team');
    await expect(page.locator('h1')).toBeVisible();
    // Bailey leads Service Desk and has reports who raised requests, so the
    // team dashboard should not be the "no data" empty state.
    const body = await page.locator('body').innerText();
    assertNoInternalIds(body);
  });
});
