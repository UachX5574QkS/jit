import { test, expect } from '@playwright/test';
import { USERS, login } from './helpers';

/**
 * The header Text Size control (accessibility): choosing a size scales the
 * content, sets html[data-text-size], and persists across a reload.
 */

test.describe('Text size control', () => {
  test('changes and persists the text size', async ({ page }) => {
    await login(page, USERS.requester.username);
    await page.goto('/requests');

    const select = page.getByRole('combobox', { name: /text size/i });
    await expect(select).toBeVisible();

    // Default is medium.
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'medium');

    // Choose Large → the root attribute updates.
    await select.selectOption('large');
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'large');

    // Persists across a reload.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'large');
    await expect(page.getByRole('combobox', { name: /text size/i })).toHaveValue('large');
  });
});
