import { test, expect } from '@playwright/test';
import { USERS, login } from './helpers';

/**
 * Task field editor (R16.2): a team leader adds fields by picking a data point
 * from a DROP-DOWN (not by typing an id). The chosen field shows its name/type
 * immediately, the picked data point disappears from the drop-down (so a
 * duplicate can't be added), and Create Task succeeds.
 */

const RUN = Date.now();

test.describe('Task field editor — data point drop-down', () => {
  test('adds fields via the drop-down and prevents duplicates', async ({ page }) => {
    await login(page, USERS.leader.username); // Bailey Adams leads Service Desk
    await page.goto('/administer/tasks');

    // Open the create-task editor.
    await page.getByRole('button', { name: /new task/i }).click();
    await page.getByLabel('Task name').fill(`E2E Field picker ${RUN}`);

    const picker = page.getByLabel(/data point to add/i);
    await expect(picker).toBeVisible();

    // The drop-down offers named data points (not numeric ids).
    const firstOptionText = await picker.locator('option:not([disabled])').first().textContent();
    expect(firstOptionText?.trim().length).toBeGreaterThan(0);

    // Pick the first real data point and add it.
    const firstValue = await picker.locator('option:not([disabled])').first().getAttribute('value');
    await picker.selectOption(firstValue!);
    await page.getByRole('button', { name: /add field/i }).click();

    // The field appears with its NAME and TYPE — never "resolved on save".
    const firstField = page.locator('.field-item').first();
    await expect(firstField).toBeVisible();
    await expect(firstField.locator('.field-name')).not.toHaveText('');
    await expect(firstField.locator('.field-type')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('resolved on save');

    // The just-added data point is no longer offered (no duplicates possible).
    await expect(
      picker.locator(`option[value="${firstValue}"]`),
    ).toHaveCount(0);

    // Add a second, different field.
    const secondValue = await picker.locator('option:not([disabled])').first().getAttribute('value');
    await picker.selectOption(secondValue!);
    await page.getByRole('button', { name: /add field/i }).click();
    await expect(page.locator('.field-item')).toHaveCount(2);

    // Create the task — it saves successfully (success banner shown).
    await page.getByRole('button', { name: /create task/i }).click();
    await expect(page.locator('.form-success')).toBeVisible();
  });
});
