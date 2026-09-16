import { expect, type Page } from '@playwright/test';

/**
 * Seeded users used across the E2E suite (all passwords: "password1"). Stable
 * across a fresh `npm --prefix backend run seed`.
 *
 *   admin      – Alex Adams (10000000): administrator.
 *   leader     – Bailey Adams (10000001): Service Desk team leader + support.
 *   support    – Casey Adams (10000002): Service Desk support member.
 *   support2   – Frankie Adams (10000005): another Service Desk member (reassign).
 *   requester  – Dana Adams (10000003): plain requester (no team membership).
 *   other      – Ellis Adams (10000004): another plain requester (isolation).
 */
export const USERS = {
  admin: { username: '10000000', name: 'Alex Adams' },
  leader: { username: '10000001', name: 'Bailey Adams' },
  support: { username: '10000002', name: 'Casey Adams' },
  support2: { username: '10000005', name: 'Frankie Adams' },
  requester: { username: '10000003', name: 'Dana Adams' },
  other: { username: '10000004', name: 'Ellis Adams' },
} as const;

export const PASSWORD = 'password1';

/** Log in via the dev drop-down as the given seeded username. */
export async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/login/);
  await expect(page.locator('#login-username')).toBeVisible();
  await page.selectOption('#login-username', username);
  await page.fill('#login-password', PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'));
}

/** Log out (clear the session) so a different user can log in. */
export async function logout(page: Page): Promise<void> {
  await page.request.post('/api/auth/logout');
  await page.context().clearCookies();
}

/** Switch account: log out then log in as another seeded user. */
export async function switchUser(page: Page, username: string): Promise<void> {
  await logout(page);
  await login(page, username);
}

/**
 * Assert the given text has NO raw internal-id artefacts meaningless to a user
 * (e.g. "Member #12", "Team #4"). The core "screens read for humans" guard.
 */
export function assertNoInternalIds(text: string): void {
  expect(text, 'should not show "Member #<id>"').not.toMatch(/Member #\d+/);
  expect(text, 'should not show "Team #<id>"').not.toMatch(/Team #\d+/);
}

/**
 * Raise a request as the currently-logged-in user and land on its detail page.
 * Returns the numeric request id parsed from the URL. Fills the title plus any
 * mandatory typed fields so validation passes.
 */
export async function raiseRequest(
  page: Page,
  opts: { team: string; task: string; title: string; jira?: string },
): Promise<number> {
  await page.goto('/new');
  await expect(page.getByRole('heading', { name: /raise a new request/i })).toBeVisible();

  await page.selectOption('#team-select', { label: opts.team });
  await expect(page.locator('#task-select')).toBeEnabled();
  await page.selectOption('#task-select', { label: opts.task });
  await page.getByRole('button', { name: /^Next$/ }).click();

  await expect(page.locator('#request-title')).toBeVisible();
  await page.fill('#request-title', opts.title);
  if (opts.jira) {
    await page.fill('#request-jira', opts.jira);
  }
  await fillRequiredFields(page);
  await page.getByRole('button', { name: /^Next$/ }).click();

  await expect(page.getByRole('heading', { name: /review your request/i })).toBeVisible();
  await page.getByRole('button', { name: /^Submit$/ }).click();

  await page.waitForURL(/\/requests\/\d+$/);
  const m = page.url().match(/\/requests\/(\d+)$/);
  return Number(m![1]);
}

/**
 * Fill every empty required field in the Step-2 form with a type-appropriate,
 * VALID value so the form validates and Next enables. Handles each control type
 * the shared form-field renders (text/email/number/date/datetime/time/checkbox/
 * select). For a plain text field it uses a value that also satisfies the common
 * REGEXP task fields in the seed (e.g. Asset Tag "PC-1234"): a bare text value
 * is tried first, and if the field carries a placeholder hinting a code format
 * we use a matching sample.
 */
export async function fillRequiredFields(page: Page): Promise<void> {
  const form = page.locator('form');
  const inputs = form.locator('input');
  for (let i = 0; i < (await inputs.count()); i += 1) {
    const el = inputs.nth(i);
    const id = (await el.getAttribute('id')) ?? '';
    if (id === 'request-title' || id === 'request-jira') continue;
    const type = (await el.getAttribute('type')) ?? 'text';
    if (type === 'checkbox' || type === 'radio') continue;
    if ((await el.inputValue()) !== '') continue;
    await el.fill(sampleForInput(type, (await el.getAttribute('placeholder')) ?? ''));
    await el.blur();
  }
  const selects = form.locator('select');
  for (let i = 0; i < (await selects.count()); i += 1) {
    const opts = selects.nth(i).locator('option');
    for (let o = 0; o < (await opts.count()); o += 1) {
      const v = await opts.nth(o).getAttribute('value');
      if (v && v.trim() !== '') {
        await selects.nth(i).selectOption(v);
        break;
      }
    }
  }
}

/** A valid sample value for an <input> given its type and placeholder hint. */
function sampleForInput(type: string, placeholder: string): string {
  switch (type) {
    case 'email':
      return 'user@example.com';
    case 'number':
      return '1';
    case 'date':
      return '2026-06-01';
    case 'datetime-local':
      return '2026-06-01T09:00';
    case 'time':
      return '09:00';
    default: {
      // A text/regexp field. The seed's REGEXP field (Asset Tag) expects a code
      // like "PC-1234"; its placeholder hints "PC-1234". Match that shape when
      // the placeholder looks code-like, otherwise a plain value is fine.
      if (/[A-Z]{2,3}-d{4}/.test(placeholder) || /asset|code|ref/i.test(placeholder)) {
        return 'PC-1234';
      }
      return 'Sample value';
    }
  }
}

/**
 * Find a request row by its unique title in the Requests list (search-scoped).
 * Pass { includeComplete: true } to uncheck "Hide Complete" first so a
 * COMPLETE/closed request is visible.
 */
export async function findInRequests(
  page: Page,
  title: string,
  opts: { includeComplete?: boolean } = {},
) {
  await page.goto('/requests');
  if (opts.includeComplete) {
    const hide = page.getByRole('checkbox', { name: /hide complete/i });
    if (await hide.isChecked().catch(() => false)) {
      await hide.uncheck();
    }
  }
  await page.getByRole('searchbox', { name: /search requests/i }).fill(title);
  const row = page.locator('tr.request-row', { hasText: title });
  await expect(row).toBeVisible();
  return row;
}

/** Find a request row by its unique title in the Support Team Queue. */
export async function findInSupportQueue(page: Page, title: string) {
  await page.goto('/support');
  await page.getByRole('button', { name: /team queue/i }).click();
  await page.getByRole('searchbox', { name: /search queue/i }).fill(title);
  const row = page.locator('tr.request-row', { hasText: title });
  await expect(row).toBeVisible();
  return row;
}

/** Open a support request detail by title and wait for /support/:id. */
export async function openSupportDetail(page: Page, title: string): Promise<void> {
  const row = await findInSupportQueue(page, title);
  await row.locator('a.ref-link').click();
  await page.waitForURL(/\/support\/\d+$/);
}

/** Open a requester request detail by title and wait for /requests/:id. */
export async function openRequestDetail(
  page: Page,
  title: string,
  opts: { includeComplete?: boolean } = {},
): Promise<void> {
  const row = await findInRequests(page, title, opts);
  await row.locator('a.ref-link').click();
  await page.waitForURL(/\/requests\/\d+$/);
}

/**
 * On the SUPPORT detail page, change the status via the offered-transition
 * drop-down and confirm the header pill reflects it. Only legal transitions
 * are offered, so `target` must be currently valid.
 */
export async function setStatus(page: Page, target: string): Promise<void> {
  const select = page.locator('#status-select');
  await expect(select).toBeVisible();
  await select.selectOption(target);
  await expect(page.locator('.detail-header .status-pill')).toContainText(target);
}

/** On the SUPPORT detail page, assign the request to a member by display name. */
export async function assignTo(page: Page, memberName: string): Promise<void> {
  await page.selectOption('#assign-select', { label: memberName });
  await expect(page.locator('.info-row', { hasText: 'Assigned To' })).toContainText(memberName);
}
