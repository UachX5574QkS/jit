import { test, expect } from '@playwright/test';

const APP_URL = 'https://ldldfcndl8jbd1z-jitdemodatabase.adb.uk-london-1.oraclecloudapps.com/ords/jit_schema/mcr-app/';

test.describe('MCR Manager - Navigation & Shell', () => {
  test('app loads and shows Active MCRs heading', async ({ page }) => {
    await page.goto(APP_URL);
    await expect(page.locator('h2')).toContainText('Active Changes');
  });

  test('sidebar has all navigation items', async ({ page }) => {
    await page.goto(APP_URL);
    const nav = page.locator('app-side-nav');
    await expect(nav.locator('text=Create')).toBeVisible();
    await expect(nav.locator('text=Active')).toBeVisible();
    await expect(nav.locator('text=Archived')).toBeVisible();
    await expect(nav.locator('text=Models')).toBeVisible();
    await expect(nav.locator('text=Admin')).toBeVisible();
    await expect(nav.locator('text=Workflows')).toBeVisible();
  });

  test('user switcher is visible in header', async ({ page }) => {
    await page.goto(APP_URL);
    await expect(page.locator('app-user-switcher')).toBeVisible();
  });
});

test.describe('MCR Manager - Active MCR List', () => {
  test('active MCR list loads and shows table', async ({ page }) => {
    await page.goto(APP_URL);
    // Wait for loading to finish
    await page.waitForSelector('mat-spinner', { state: 'hidden', timeout: 10000 }).catch(() => {});
    // Should have either a table or an empty message (may have multiple tables for different types)
    const table = page.locator('table.mcr-table').first();
    const emptyText = page.locator('.empty-text');
    await expect(table.or(emptyText)).toBeVisible();
  });

  test('MCR table has expected columns', async ({ page }) => {
    await page.goto(APP_URL);
    await page.waitForSelector('mat-spinner', { state: 'hidden', timeout: 10000 }).catch(() => {});
    const headerRow = page.locator('table.mcr-table tr').first();
    if (await headerRow.isVisible()) {
      await expect(headerRow).toContainText('Reference');
      await expect(headerRow).toContainText('Status');
    }
  });

  test('clicking an MCR row navigates to task detail', async ({ page }) => {
    await page.goto(APP_URL);
    await page.waitForSelector('mat-spinner', { state: 'hidden', timeout: 10000 }).catch(() => {});
    const firstRow = page.locator('table.mcr-table tr.clickable-row').first();
    if (await firstRow.isVisible()) {
      await firstRow.click();
      await expect(page.locator('h2')).toContainText('Tasks');
    }
  });
});

test.describe('MCR Manager - Models View', () => {
  test('navigating to Models shows the models list', async ({ page }) => {
    await page.goto(APP_URL + '#/models');
    await page.waitForSelector('mat-spinner', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await expect(page.locator('h2')).toContainText('Models');
  });

  test('models list shows the example model', async ({ page }) => {
    await page.goto(APP_URL + '#/models');
    await page.waitForSelector('mat-spinner', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await expect(page.locator('text=New Application & Infrastructure Build')).toBeVisible();
  });

  test('clicking a model opens the detail dialog', async ({ page }) => {
    await page.goto(APP_URL + '#/models');
    await page.waitForSelector('mat-spinner', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.locator('text=New Application & Infrastructure Build').first().click();
    // Wait for dialog to appear
    await expect(page.locator('mat-dialog-container')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('mat-dialog-container')).toContainText('New Application & Infrastructure Build');
  });

  test('model detail shows task list with 20 tasks', async ({ page }) => {
    await page.goto(APP_URL + '#/models');
    await page.waitForSelector('mat-spinner', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.locator('text=New Application & Infrastructure Build').first().click();
    await expect(page.locator('mat-dialog-container')).toBeVisible({ timeout: 5000 });
    // Wait for tasks to load
    await page.waitForSelector('mat-dialog-container mat-spinner', { state: 'hidden', timeout: 10000 }).catch(() => {});
    // Should have task rows
    const taskRows = page.locator('mat-dialog-container table tr[mat-row]');
    await expect(taskRows).toHaveCount(20, { timeout: 10000 });
  });

  test('model detail shows dependency map', async ({ page }) => {
    await page.goto(APP_URL + '#/models');
    await page.waitForSelector('mat-spinner', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.locator('text=New Application & Infrastructure Build').first().click();
    await expect(page.locator('mat-dialog-container')).toBeVisible({ timeout: 5000 });
    await page.waitForSelector('mat-dialog-container mat-spinner', { state: 'hidden', timeout: 10000 }).catch(() => {});
    // Cytoscape container should be present
    const cyContainer = page.locator('.cytoscape-container');
    await expect(cyContainer).toBeVisible({ timeout: 5000 });
  });
});

test.describe('MCR Manager - Create MCR', () => {
  test('create view shows MCR form', async ({ page }) => {
    await page.goto(APP_URL + '#/create');
    await expect(page.locator('mat-card-title').first()).toContainText('Create MCR');
  });

  test('create form has Use Model dropdown', async ({ page }) => {
    await page.goto(APP_URL + '#/create');
    await expect(page.locator('text=Use Model (optional)')).toBeVisible();
  });

  test('form validation prevents empty submission', async ({ page }) => {
    await page.goto(APP_URL + '#/create');
    // Click Save without filling anything
    await page.locator('button:has-text("Save")').click();
    // Should show validation errors (multiple mat-error elements)
    await expect(page.locator('mat-error').first()).toBeVisible();
  });
});

test.describe('MCR Manager - Archived View', () => {
  test('archived view loads', async ({ page }) => {
    await page.goto(APP_URL + '#/archived');
    await page.waitForSelector('mat-spinner', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await expect(page.locator('h2')).toContainText('Archived Changes');
  });
});

test.describe('MCR Manager - Admin View', () => {
  test('admin view shows Teams section', async ({ page }) => {
    await page.goto(APP_URL + '#/admin');
    await page.waitForSelector('mat-spinner', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await expect(page.locator('h3:has-text("Teams")')).toBeVisible();
  });
});

test.describe('MCR Manager - Dependency Map', () => {
  test('dependency map dialog opens for an MCR with tasks', async ({ page }) => {
    await page.goto(APP_URL);
    await page.waitForSelector('mat-spinner', { state: 'hidden', timeout: 10000 }).catch(() => {});
    // Find the dependency map button on the first MCR row
    const mapButton = page.locator('button[mattooltip="Dependency Map"]').first();
    if (await mapButton.isVisible()) {
      await mapButton.click();
      await expect(page.locator('mat-dialog-container')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('mat-dialog-container h2')).toContainText('Dependency Map');
    }
  });
});
