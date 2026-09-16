import { test, expect, type Page } from '@playwright/test';
import { USERS, login, switchUser, assertNoInternalIds } from './helpers';

/**
 * Full requester ↔ support lifecycle, driven in a real browser:
 *   1. Requester logs in, raises a Service Desk "Unlock User Account" request.
 *   2. Requester sees it in their list (human-readable columns, no ids) and
 *      opens the detail.
 *   3. Support member logs in, finds the request, assigns it to themselves,
 *      moves it through the status flow, and adds an INTERNAL note.
 *   4. Requester logs back in and confirms: they see the external content and
 *      the updated status, but NOT the internal note; screens show names and
 *      titles, never internal ids.
 *
 * A unique title ties the whole flow together so the specs are order-independent
 * against the shared seeded database.
 */

const RUN = Date.now();
const REQUEST_TITLE = `E2E Unlock request ${RUN}`;
const TEAM = 'Service Desk';
const TASK = 'Unlock User Account';

/** Raise a request as the currently-logged-in user; returns the detail URL. */
async function raiseRequest(page: Page): Promise<string> {
  await page.goto('/new');
  await expect(page.getByRole('heading', { name: /raise a new request/i })).toBeVisible();

  // Step 1: team + task
  await page.selectOption('#team-select', { label: TEAM });
  await expect(page.locator('#task-select')).toBeEnabled();
  await page.selectOption('#task-select', { label: TASK });
  await page.getByRole('button', { name: /^Next$/ }).click();

  // Step 2: title + mandatory fields. Fill the title, then any empty required
  // text/email inputs the task defines so validation passes.
  await expect(page.locator('#request-title')).toBeVisible();
  await page.fill('#request-title', REQUEST_TITLE);
  await fillRequiredFields(page);
  await page.getByRole('button', { name: /^Next$/ }).click();

  // Step 3: review → submit
  await expect(page.getByRole('heading', { name: /review your request/i })).toBeVisible();
  await page.getByRole('button', { name: /^Submit$/ }).click();

  // Lands on the detail page /requests/:id
  await page.waitForURL(/\/requests\/\d+$/);
  return page.url();
}

/**
 * Fill every visible required field in the Step-2 form with a type-appropriate
 * value so the form validates. Text/email get sample strings; selects choose
 * their first real option; checkboxes are left as-is.
 */
async function fillRequiredFields(page: Page): Promise<void> {
  const form = page.locator('form');
  // Text & email inputs (skip the title/jira we handle explicitly).
  const inputs = form.locator('input[type="text"], input[type="email"]');
  const count = await inputs.count();
  for (let i = 0; i < count; i += 1) {
    const el = inputs.nth(i);
    const id = (await el.getAttribute('id')) ?? '';
    if (id === 'request-title' || id === 'request-jira') continue;
    const type = await el.getAttribute('type');
    if ((await el.inputValue()) === '') {
      await el.fill(type === 'email' ? 'user@example.com' : 'jsmith');
    }
  }
  // Selects (dropdown fields): choose the first non-placeholder option.
  const selects = form.locator('select');
  const sCount = await selects.count();
  for (let i = 0; i < sCount; i += 1) {
    const sel = selects.nth(i);
    const options = sel.locator('option');
    const oCount = await options.count();
    for (let o = 0; o < oCount; o += 1) {
      const value = await options.nth(o).getAttribute('value');
      if (value && value.trim() !== '') {
        await sel.selectOption(value);
        break;
      }
    }
  }
}

test.describe('Requester ↔ Support lifecycle', () => {
  test('requester raises a request and sees it with human-readable content', async ({ page }) => {
    await login(page, USERS.requester.username);

    const detailUrl = await raiseRequest(page);

    // Detail shows the title, the team title (not an id), and status NEW.
    await expect(page.getByRole('heading', { name: REQUEST_TITLE })).toBeVisible();
    const detailText = (await page.locator('body').innerText());
    expect(detailText).toContain(TEAM);
    expect(detailText).toContain('NEW');
    assertNoInternalIds(detailText);

    // The request appears in "My Requests" with readable columns. Filter by the
    // unique title via the search box so the lookup is deterministic.
    await page.goto('/requests');
    await page.getByRole('searchbox', { name: /search requests/i }).fill(REQUEST_TITLE);
    const row = page.locator('tr.request-row', { hasText: REQUEST_TITLE });
    await expect(row).toBeVisible();
    await expect(row).toContainText(TEAM);      // Support Team column = title
    await expect(row).toContainText('NEW');     // Status
    assertNoInternalIds(await page.locator('table.requests-table').innerText());
  });

  test('support assigns, progresses status, and adds an internal note', async ({ page }) => {
    await switchUser(page, USERS.support.username);

    // Find the request in the TEAM queue (it is NEW + unassigned). Switch to
    // Team Queue and filter by the unique title via search for determinism.
    await page.goto('/support');
    await page.getByRole('button', { name: /team queue/i }).click();
    await page.getByRole('searchbox', { name: /search queue/i }).fill(REQUEST_TITLE);
    const row = page.locator('tr.request-row', { hasText: REQUEST_TITLE });
    await expect(row).toBeVisible();
    await row.locator('a.ref-link').click();
    await page.waitForURL(/\/support\/\d+$/);

    // Assign to self (Casey Adams) via the assignment drop-down (by name).
    await page.selectOption('#assign-select', { label: USERS.support.name });
    // The "Assigned To" info row now shows the name, not an id.
    await expect(page.locator('.info-row', { hasText: 'Assigned To' })).toContainText(
      USERS.support.name,
    );

    // Progress status NEW → TRIAGE → ACCEPTED using only offered transitions.
    await progressStatus(page, 'TRIAGE');
    await progressStatus(page, 'ACCEPTED');

    // Add an INTERNAL note (support-only).
    const internalBody = `Internal diagnosis ${RUN}`;
    await page.fill('#new-note', internalBody);
    await page.getByText('Internal (support only)').click();
    await page.getByRole('button', { name: /add note/i }).click();
    await expect(page.locator('.note-item.is-internal', { hasText: internalBody })).toBeVisible();

    // Reload so the audit trail reflects all persisted changes (each mutation
    // reloads asynchronously; a hard reload gives a settled, final view).
    await page.reload();
    await expect(page.locator('.audit-list')).toBeVisible();
    // The assignment audit entry should now be present with a friendly label.
    // NOTE: .audit-field is uppercased via CSS text-transform, so innerText
    // returns "ASSIGNED TO"; assert case-insensitively on the rendered text.
    await expect(
      page.locator('.audit-item').filter({ hasText: /assigned to/i }),
    ).toBeVisible();
    const auditText = await page.locator('.audit-list').innerText();
    assertNoInternalIds(auditText);
    expect(auditText.toLowerCase()).toContain('assigned to');
    expect(auditText).toContain(USERS.support.name);
  });

  test('requester sees external updates but never the internal note', async ({ page }) => {
    await switchUser(page, USERS.requester.username);

    await page.goto('/requests');
    await page.getByRole('searchbox', { name: /search requests/i }).fill(REQUEST_TITLE);
    const row = page.locator('tr.request-row', { hasText: REQUEST_TITLE });
    await expect(row).toBeVisible();
    // Support progressed it past NEW and assigned it to Casey — both readable.
    await expect(row).toContainText(USERS.support.name);
    // The row is highlighted (light-teal) because it changed since the raiser
    // last viewed it — the "Updated" column has been replaced by this cue.
    await expect(row).toHaveClass(/is-updated/);
    await row.locator('a.ref-link').click();
    await page.waitForURL(/\/requests\/\d+$/);

    // Wait for the detail to finish loading: the "Assigned To" info row should
    // resolve to the assignee's NAME (not an id, not "Loading…").
    await expect(page.locator('.info-row', { hasText: 'Assigned To' })).toContainText(
      USERS.support.name,
    );
    // Status reflects support's progress (ACCEPTED), not the original NEW.
    await expect(page.locator('.info-row', { hasText: 'Status' })).toContainText('ACCEPTED');

    const body = await page.locator('body').innerText();
    // The internal note must NOT be visible to the requester.
    expect(body).not.toContain(`Internal diagnosis ${RUN}`);
    // No internal ids anywhere on the requester's detail view.
    assertNoInternalIds(body);
    // The assignee's name appears (info row + assignment audit entry).
    expect(body).toContain(USERS.support.name);
  });
});

/** Choose a status from the offered next-transition drop-down and confirm it. */
async function progressStatus(page: Page, target: string): Promise<void> {
  const select = page.locator('#status-select');
  await expect(select).toBeVisible();
  await select.selectOption(target);
  // Header status pill reflects the new status.
  await expect(page.locator('.detail-header .status-pill')).toContainText(target);
}
