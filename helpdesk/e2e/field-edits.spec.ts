import { test, expect } from '@playwright/test';
import { USERS, login, raiseRequest } from './helpers';

/**
 * Requester field edits (R5.4): the raiser can edit their own fields, a
 * mandatory field cannot be blanked (client-side validation blocks Save), and a
 * valid edit persists and shows in the audit trail.
 */

const RUN = Date.now();
const TEAM = 'Service Desk';
const TASK = 'Unlock User Account';

test.describe('Requester field edits', () => {
  test('edits a field, cannot blank a mandatory one, saves a valid change', async ({ page }) => {
    await login(page, USERS.requester.username);
    const title = `E2E Field edit ${RUN}`;
    await raiseRequest(page, { team: TEAM, task: TASK, title });

    // Enter edit mode via the "Edit my fields" affordance.
    const editBtn = page.getByRole('button', { name: /edit my fields/i });
    await expect(editBtn).toBeVisible();
    await editBtn.click();

    // The edit form is shown with per-field controls + a Save button.
    const form = page.locator('form');
    await expect(form).toBeVisible();

    const save = page.getByRole('button', { name: /save changes/i });

    // Blank the first mandatory text field → Save Changes must become disabled
    // (a mandatory field cannot be blanked, R5.4).
    const firstText = form.locator('input[type="text"]').first();
    await expect(firstText).toBeVisible();
    const original = await firstText.inputValue();
    await firstText.fill('');
    await expect(save).toBeDisabled();

    // Enter a valid new value → Save Changes enables; save it.
    const updated = original && original !== '' ? original + ' (edited)' : 'Edited value';
    await firstText.fill(updated);
    await expect(save).toBeEnabled();
    await save.click();

    // Back in read mode; the new value is shown and the audit trail has entries.
    await expect(page.getByRole('button', { name: /edit my fields/i })).toBeVisible();
    await expect(page.locator('body')).toContainText(updated);
    await expect(page.locator('.audit-item').first()).toBeVisible();
  });
});
