import { test, expect, type Page } from '@playwright/test';
import { USERS, login, switchUser, assertNoInternalIds } from './helpers';

/**
 * Requester-side actions and the cancel → reopen path, plus confirming an
 * EXTERNAL note the requester adds is visible to support (the reverse of the
 * internal-note direction covered in lifecycle.spec).
 */

const RUN = Date.now();
const TITLE = `E2E Requester actions ${RUN}`;
const TEAM = 'Service Desk';
const TASK = 'Password Reset';

async function raise(page: Page): Promise<void> {
  await page.goto('/new');
  await page.selectOption('#team-select', { label: TEAM });
  await expect(page.locator('#task-select')).toBeEnabled();
  await page.selectOption('#task-select', { label: TASK });
  await page.getByRole('button', { name: /^Next$/ }).click();
  await page.fill('#request-title', TITLE);
  // Fill any empty required text/email inputs + first real select option.
  const form = page.locator('form');
  const inputs = form.locator('input[type="text"], input[type="email"]');
  for (let i = 0; i < (await inputs.count()); i += 1) {
    const el = inputs.nth(i);
    const id = (await el.getAttribute('id')) ?? '';
    if (id === 'request-title' || id === 'request-jira') continue;
    if ((await el.inputValue()) === '') {
      await el.fill((await el.getAttribute('type')) === 'email' ? 'user@example.com' : 'jsmith');
    }
  }
  const selects = form.locator('select');
  for (let i = 0; i < (await selects.count()); i += 1) {
    const opts = selects.nth(i).locator('option');
    for (let o = 0; o < (await opts.count()); o += 1) {
      const v = await opts.nth(o).getAttribute('value');
      if (v && v.trim() !== '') { await selects.nth(i).selectOption(v); break; }
    }
  }
  await page.getByRole('button', { name: /^Next$/ }).click();
  await page.getByRole('button', { name: /^Submit$/ }).click();
  await page.waitForURL(/\/requests\/\d+$/);
}

test.describe('Requester actions: note, cancel, reopen', () => {
  test('requester adds an external note, cancels, then reopens', async ({ page }) => {
    await login(page, USERS.requester.username);
    await raise(page);

    // Add an external note (requester notes are always external).
    const noteBody = `Requester note ${RUN}`;
    const noteBox = page.locator('textarea');
    await expect(noteBox.first()).toBeVisible();
    await noteBox.first().fill(noteBody);
    await page.getByRole('button', { name: /add note/i }).click();
    await expect(page.locator('.note-body', { hasText: noteBody })).toBeVisible();

    // Cancel the request (raiser, non-stop state → CANCELLED).
    await page.getByRole('button', { name: /cancel request/i }).click();
    await expect(page.locator('.info-row', { hasText: 'Status' })).toContainText('CANCELLED');

    // Reopen (raiser who cancelled → NEW).
    await page.getByRole('button', { name: /^Reopen$/ }).click();
    await expect(page.locator('.info-row', { hasText: 'Status' })).toContainText('NEW');

    assertNoInternalIds(await page.locator('body').innerText());
  });

  test('support sees the requester external note', async ({ page }) => {
    await switchUser(page, USERS.support.username);
    await page.goto('/support');
    await page.getByRole('button', { name: /team queue/i }).click();
    await page.getByRole('searchbox', { name: /search queue/i }).fill(TITLE);
    const row = page.locator('tr.request-row', { hasText: TITLE });
    await expect(row).toBeVisible();
    await row.locator('a.ref-link').click();
    await page.waitForURL(/\/support\/\d+$/);

    // The requester's external note is visible to support.
    await expect(page.locator('.note-body', { hasText: `Requester note ${RUN}` })).toBeVisible();
    assertNoInternalIds(await page.locator('body').innerText());
  });
});
