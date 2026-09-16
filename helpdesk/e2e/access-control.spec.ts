import { test, expect } from '@playwright/test';
import { USERS, PASSWORD, login, logout } from './helpers';

/**
 * Authentication and role-based access control (R1.4, R1.8, R6.1, R13/R14
 * admin guards). Verifies bad credentials are rejected, and that role guards
 * keep users out of screens they may not use.
 */

test.describe('Auth & access control', () => {
  test('rejects an invalid password with an inline message and no session', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/\/login/);
    await page.selectOption('#login-username', USERS.requester.username);
    await page.fill('#login-password', 'wrong-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.locator('.login-error')).toContainText(/invalid username or password/i);
    // Still on the login page (no session established).
    await expect(page).toHaveURL(/\/login/);
  });

  test('logs in and out; logout returns to the login screen', async ({ page }) => {
    await login(page, USERS.requester.username);
    await expect(page).not.toHaveURL(/\/login/);
    await logout(page);
    await page.goto('/requests');
    // Unauthenticated access to a guarded route bounces to login.
    await page.waitForURL(/\/login/);
  });

  test('a plain requester cannot reach the Support screen (support guard)', async ({ page }) => {
    await login(page, USERS.requester.username);
    await page.goto('/support');
    // The support guard redirects a non-support user away from /support.
    await expect(page).not.toHaveURL(/\/support(\/|$)/);
  });

  test('a non-admin cannot reach Team administration (admin guard)', async ({ page }) => {
    await login(page, USERS.support.username);
    await page.goto('/administer/teams');
    await expect(page).not.toHaveURL(/\/administer\/teams(\/|$)/);
  });

  test('an admin CAN reach Team administration', async ({ page }) => {
    await login(page, USERS.admin.username);
    await page.goto('/administer/teams');
    await expect(page).toHaveURL(/\/administer\/teams/);
    await expect(page.locator('body')).toContainText('Service Desk');
  });
});
