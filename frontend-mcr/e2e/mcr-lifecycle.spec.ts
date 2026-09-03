import { test, expect, Page } from '@playwright/test';

const APP = 'https://ldldfcndl8jbd1z-jitdemodatabase.adb.uk-london-1.oraclecloudapps.com/ords/jit_schema/mcr-app/';
const API = 'https://ldldfcndl8jbd1z-jitdemodatabase.adb.uk-london-1.oraclecloudapps.com/ords/jit_schema/mcr/v1';
const MODEL_ID = 2; // "New Application & Infrastructure Build" (20 tasks)

function mcrNumber(prefix: string) {
  return `${prefix}-${Date.now().toString(36).toUpperCase().slice(-5)}`;
}

const today = new Date().toISOString().split('T')[0];
const endDate = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];

async function waitForLoad(page: Page) {
  await page.waitForSelector('mat-spinner', { state: 'hidden', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
}

// Helper: Create an MCR from a model and return mcr_id + task_ids
async function createMCRFromModel(request: any, mcrNum: string, description: string): Promise<{ mcrId: number; taskIds: number[] }> {
  // 1. Create MCR
  const createRes = await request.post(`${API}/requests/`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      mcr_number: mcrNum,
      owner_user_id: 1,
      description,
      start_date: today,
      end_date: endDate,
      raci: JSON.stringify([
        { user_id: 1, role: 'Accountable', type: 'USER' },
        { user_id: 2, role: 'Coordinator', type: 'USER' },
        { user_id: 6, role: 'Informed', type: 'USER' }
      ]),
      user_id: 1
    }
  });
  const mcrData = await createRes.json();
  const mcrId = mcrData.mcr_id;

  // 2. Fetch model tasks
  const modelRes = await request.get(`${API}/models/${MODEL_ID}`);
  const modelData = await modelRes.json();
  const modelTasks = (modelData.tasks ?? []).sort((a: any, b: any) => (a.task_seq ?? 0) - (b.task_seq ?? 0));

  // 3. Copy model tasks into MCR (first 5 tasks for manageable test size)
  const taskIds: number[] = [];
  const seqToId = new Map<number, number>();

  for (let i = 0; i < Math.min(5, modelTasks.length); i++) {
    const mt = modelTasks[i];
    // Map hard_dep_seqs to actual task IDs
    let hardDeps = '';
    if (mt.hard_dep_seqs) {
      const seqs = String(mt.hard_dep_seqs).split(',').map((s: string) => Number(s.trim())).filter((n: number) => n > 0);
      const mapped = seqs.map((seq: number) => seqToId.get(seq)).filter((id: number | undefined) => id != null);
      hardDeps = mapped.join(',');
    }

    const taskRes = await request.post(`${API}/tasks/mcr/${mcrId}`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        user_id: 1,
        title: mt.title,
        description: mt.description || '',
        jira_reference: `FSOC-${4000 + i}`,
        owner_dept_id: 100,
        implementor_id: (i % 3) + 1, // Rotate users 1, 2, 3
        implementor_type: 'USER',
        sub_actions: mt.sub_actions || 'Step 1: Execute\nStep 2: Verify',
        backout_plan: mt.backout_plan || 'Revert changes',
        estimated_duration_mins: mt.estimated_duration_mins || 60,
        start_date: today,
        start_time: `${String(6 + i).padStart(2, '0')}:00`,
        hard_deps_csv: hardDeps
      }
    });
    const taskData = await taskRes.json();
    taskIds.push(taskData.task_id);
    seqToId.set(mt.task_seq, taskData.task_id);
  }

  return { mcrId, taskIds };
}

// Helper: Attach TCD to all tasks
async function attachTCDs(request: any, mcrId: number, taskIds: number[]) {
  for (const taskId of taskIds) {
    const docRes = await request.post(`${API}/documents/mcr/${mcrId}`, {
      headers: { 'Content-Type': 'application/json' },
      data: { user_id: 1, title: 'Test Completion Document', content_type: 'application/pdf' }
    });
    const doc = await docRes.json();
    await request.put(`${API}/documents/links/${taskId}`, {
      headers: { 'Content-Type': 'application/json' },
      data: { document_ids: [doc.document_id] }
    });
  }
}

// Helper: Approve all tasks and start MCR
async function approveAndStartMCR(request: any, mcrId: number, taskIds: number[]) {
  for (const taskId of taskIds) {
    await request.post(`${API}/tasks/status`, {
      headers: { 'Content-Type': 'application/json' },
      data: { user_id: 1, task_id: taskId, new_status: 'Approved' }
    });
  }
  await request.post(`${API}/requests/${mcrId}/lifecycle`, {
    headers: { 'Content-Type': 'application/json' },
    data: { action: 'approve', user_id: 1 }
  });
  await request.post(`${API}/requests/${mcrId}/lifecycle`, {
    headers: { 'Content-Type': 'application/json' },
    data: { action: 'start', user_id: 1 }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: Model-based MCR runs to COMPLETION
// ─────────────────────────────────────────────────────────────────────────────
test.describe.serial('Scenario 1: Model MCR → COMPLETE', () => {
  let mcrId: number;
  let taskIds: number[] = [];
  const mcr = mcrNumber('MODEL-OK');

  test('1.1 Create MCR from model with 5 tasks', async ({ request }) => {
    const result = await createMCRFromModel(request, mcr, 'Model-based MCR running to completion');
    mcrId = result.mcrId;
    taskIds = result.taskIds;
    expect(mcrId).toBeGreaterThan(0);
    expect(taskIds.length).toBe(5);
  });

  test('1.2 Verify tasks copied from model correctly', async ({ request }) => {
    const res = await request.get(`${API}/tasks/mcr/${mcrId}`);
    const tasks = (await res.json()).items;
    expect(tasks.length).toBe(5);
    expect(tasks[0].title).toBe('Provision VPC and Subnets');
    expect(tasks[0].sub_actions).toBeTruthy();
    expect(tasks[0].backout_plan).toBeTruthy();
    expect(tasks[0].jira_reference).toContain('FSOC-');
  });

  test('1.3 Attach TCD documents to all tasks', async ({ request }) => {
    await attachTCDs(request, mcrId, taskIds);
  });

  test('1.4 Approve all tasks and start MCR', async ({ request }) => {
    await approveAndStartMCR(request, mcrId, taskIds);
  });

  test('1.5 Verify MCR is Active', async ({ request }) => {
    const res = await request.get(`${API}/requests/${mcrId}`);
    const body = await res.json();
    expect(body.mcr_status).toBe('Active');
  });

  test('1.6 Start and complete all 5 tasks', async ({ request }) => {
    for (const taskId of taskIds) {
      await request.post(`${API}/tasks/status`, {
        headers: { 'Content-Type': 'application/json' },
        data: { user_id: 1, task_id: taskId, new_status: 'Started' }
      });
      await request.post(`${API}/tasks/status`, {
        headers: { 'Content-Type': 'application/json' },
        data: { user_id: 1, task_id: taskId, new_status: 'Complete' }
      });
    }
  });

  test('1.7 Complete MCR', async ({ request }) => {
    const res = await request.post(`${API}/requests/${mcrId}/lifecycle`, {
      headers: { 'Content-Type': 'application/json' },
      data: { action: 'complete', user_id: 1 }
    });
    expect(res.ok()).toBeTruthy();
  });

  test('1.8 Verify all tasks have actual start/end dates', async ({ request }) => {
    const res = await request.get(`${API}/tasks/mcr/${mcrId}`);
    for (const task of (await res.json()).items) {
      expect(task.task_status).toBe('Complete');
      expect(task.actual_start_date).toBeTruthy();
      expect(task.actual_end_date).toBeTruthy();
    }
  });

  test('1.9 Verify MCR in Archived view', async ({ page }) => {
    await page.goto(APP + '#/archived');
    await waitForLoad(page);
    await expect(page.locator(`text=${mcr}`)).toBeVisible({ timeout: 5000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: Model-based MCR FAILS (dependency cascade)
// ─────────────────────────────────────────────────────────────────────────────
test.describe.serial('Scenario 2: Model MCR → FAILED (cascade)', () => {
  let mcrId: number;
  let taskIds: number[] = [];
  const mcr = mcrNumber('MODEL-FAIL');

  test('2.1 Create MCR from model', async ({ request }) => {
    const result = await createMCRFromModel(request, mcr, 'Model-based MCR that will fail with cascade');
    mcrId = result.mcrId;
    taskIds = result.taskIds;
    expect(taskIds.length).toBe(5);
  });

  test('2.2 Attach TCDs, approve, and start', async ({ request }) => {
    await attachTCDs(request, mcrId, taskIds);
    await approveAndStartMCR(request, mcrId, taskIds);
  });

  test('2.3 Complete task 1, then FAIL task 2 with cascade', async ({ request }) => {
    // Start and complete task 1
    await request.post(`${API}/tasks/status`, {
      headers: { 'Content-Type': 'application/json' },
      data: { user_id: 1, task_id: taskIds[0], new_status: 'Started' }
    });
    await request.post(`${API}/tasks/status`, {
      headers: { 'Content-Type': 'application/json' },
      data: { user_id: 1, task_id: taskIds[0], new_status: 'Complete' }
    });

    // Start task 2
    await request.post(`${API}/tasks/status`, {
      headers: { 'Content-Type': 'application/json' },
      data: { user_id: 1, task_id: taskIds[1], new_status: 'Started' }
    });

    // Fail task 2 with cascade
    const res = await request.post(`${API}/tasks/status`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        user_id: 1,
        task_id: taskIds[1],
        new_status: 'Failed',
        closure_reason: 'Security group configuration failed - port conflicts detected',
        cascade_action: 'block'
      }
    });
    expect(res.ok()).toBeTruthy();
  });

  test('2.4 Verify task statuses after cascade', async ({ request }) => {
    const res = await request.get(`${API}/tasks/mcr/${mcrId}`);
    const tasks = (await res.json()).items;
    expect(tasks[0].task_status).toBe('Complete');
    expect(tasks[1].task_status).toBe('Failed');
    expect(tasks[1].closure_reason).toContain('port conflicts');
    expect(tasks[1].actual_start_date).toBeTruthy();
    expect(tasks[1].actual_end_date).toBeTruthy();
  });

  test('2.5 Cancel remaining tasks and mark MCR as Failed', async ({ request }) => {
    // Cancel remaining non-terminal tasks (simulates user ending MCR)
    const taskRes = await request.get(`${API}/tasks/mcr/${mcrId}`);
    const tasks = (await taskRes.json()).items;
    for (const task of tasks) {
      if (!['Complete', 'Failed', 'Cancelled', 'Blocked_Dep', 'Skipped', 'Partial_Success'].includes(task.task_status)) {
        await request.post(`${API}/tasks/status`, {
          headers: { 'Content-Type': 'application/json' },
          data: { user_id: 1, task_id: task.task_id, new_status: 'Cancelled', closure_reason: 'MCR ended due to failure' }
        });
      }
    }

    // Now mark MCR as Failed (user action)
    const res = await request.post(`${API}/requests/${mcrId}/lifecycle`, {
      headers: { 'Content-Type': 'application/json' },
      data: { action: 'failed', user_id: 1, notes: 'Failed due to task 2 security group misconfiguration' }
    });
    expect(res.ok()).toBeTruthy();
  });

  test('2.6 Verify MCR status is Failed', async ({ request }) => {
    const res = await request.get(`${API}/requests/${mcrId}`);
    expect((await res.json()).mcr_status).toBe('Failed');
  });

  test('2.7 Verify all tasks in end state', async ({ request }) => {
    const res = await request.get(`${API}/tasks/mcr/${mcrId}`);
    const tasks = (await res.json()).items;
    const endStates = ['Complete', 'Failed', 'Cancelled', 'Blocked_Dep', 'Skipped', 'Partial_Success'];
    for (const task of tasks) {
      expect(endStates).toContain(task.task_status);
    }
  });

  test('2.8 Verify in Archived view', async ({ page }) => {
    await page.goto(APP + '#/archived');
    await waitForLoad(page);
    await expect(page.locator(`text=${mcr}`)).toBeVisible({ timeout: 5000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: Model-based MCR IN PROGRESS (not finished)
// ─────────────────────────────────────────────────────────────────────────────
test.describe.serial('Scenario 3: Model MCR → IN PROGRESS', () => {
  let mcrId: number;
  let taskIds: number[] = [];
  const mcr = mcrNumber('MODEL-RUN');

  test('3.1 Create MCR from model', async ({ request }) => {
    const result = await createMCRFromModel(request, mcr, 'Model-based MCR still running at 60%');
    mcrId = result.mcrId;
    taskIds = result.taskIds;
    expect(taskIds.length).toBe(5);
  });

  test('3.2 Attach TCDs, approve, and start', async ({ request }) => {
    await attachTCDs(request, mcrId, taskIds);
    await approveAndStartMCR(request, mcrId, taskIds);
  });

  test('3.3 Complete tasks 1-3, leave 4-5 as Approved', async ({ request }) => {
    for (let i = 0; i < 3; i++) {
      await request.post(`${API}/tasks/status`, {
        headers: { 'Content-Type': 'application/json' },
        data: { user_id: 1, task_id: taskIds[i], new_status: 'Started' }
      });
      await request.post(`${API}/tasks/status`, {
        headers: { 'Content-Type': 'application/json' },
        data: { user_id: 1, task_id: taskIds[i], new_status: 'Complete' }
      });
    }
  });

  test('3.4 Verify MCR is Active', async ({ request }) => {
    const res = await request.get(`${API}/requests/${mcrId}`);
    expect((await res.json()).mcr_status).toBe('Active');
  });

  test('3.5 Verify 3 complete, 2 waiting', async ({ request }) => {
    const res = await request.get(`${API}/tasks/mcr/${mcrId}`);
    const tasks = (await res.json()).items;
    const complete = tasks.filter((t: any) => t.task_status === 'Complete');
    const waiting = tasks.filter((t: any) => ['Ready', 'Pending', 'Approved'].includes(t.task_status));
    expect(complete.length).toBe(3);
    expect(waiting.length).toBe(2);
  });

  test('3.6 Verify Active MCR in Active view with progress', async ({ page }) => {
    await page.goto(APP);
    await waitForLoad(page);
    await expect(page.locator(`text=${mcr}`)).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=3/5').first()).toBeVisible({ timeout: 5000 });
  });

  test('3.7 Verify dependency map opens', async ({ page }) => {
    await page.goto(APP);
    await waitForLoad(page);
    const mapBtn = page.locator('button[mattooltip="Dependency Map"]').first();
    if (await mapBtn.isVisible()) {
      await mapBtn.click();
      await expect(page.locator('mat-dialog-container')).toBeVisible({ timeout: 5000 });
      await page.locator('mat-dialog-container button:has-text("Close")').click();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: Create MCR from model (NOT started yet — Draft/Ready)
// ─────────────────────────────────────────────────────────────────────────────
test.describe.serial('Scenario 4: Model MCR → READY (not started)', () => {
  let mcrId: number;
  let taskIds: number[] = [];
  const mcr = mcrNumber('MODEL-READY');

  test('4.1 Create MCR from model', async ({ request }) => {
    const result = await createMCRFromModel(request, mcr, 'Model-based MCR prepared but not started');
    mcrId = result.mcrId;
    taskIds = result.taskIds;
    expect(taskIds.length).toBe(5);
  });

  test('4.2 Verify MCR is in Draft status', async ({ request }) => {
    const res = await request.get(`${API}/requests/${mcrId}`);
    expect((await res.json()).mcr_status).toBe('Draft');
  });

  test('4.3 Verify all tasks have model content (SOE, backout)', async ({ request }) => {
    const res = await request.get(`${API}/tasks/mcr/${mcrId}`);
    const tasks = (await res.json()).items;
    for (const task of tasks) {
      expect(task.sub_actions).toBeTruthy();
      expect(task.backout_plan).toBeTruthy();
      expect(task.jira_reference).toBeTruthy();
      expect(task.implementor_id).toBeTruthy();
      expect(task.est_start_date).toBeTruthy();
    }
  });

  test('4.4 Verify MCR appears in Active list (Draft state)', async ({ page }) => {
    await page.goto(APP);
    await waitForLoad(page);
    await expect(page.locator(`text=${mcr}`)).toBeVisible({ timeout: 5000 });
  });

  test('4.5 Verify can drill into tasks', async ({ page }) => {
    await page.goto(APP);
    await waitForLoad(page);
    // Click the row (not the MCR number link which goes to edit)
    const row = page.locator(`table.mcr-table tr.clickable-row:has-text("${mcr}")`);
    await row.click();
    await waitForLoad(page);
    await expect(page.locator('h2')).toContainText('Tasks');
    // Should show 5 tasks from the model
    const rows = page.locator('table tr.clickable-row');
    await expect(rows).toHaveCount(5, { timeout: 5000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Final UI verification
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Final UI Verification', () => {
  test('Active view shows Draft and Active MCRs', async ({ page }) => {
    await page.goto(APP);
    await waitForLoad(page);
    const rows = page.locator('table.mcr-table tr.clickable-row');
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(2); // Active + Draft
  });

  test('Archived view shows Complete and Failed MCRs', async ({ page }) => {
    await page.goto(APP + '#/archived');
    await waitForLoad(page);
    const rows = page.locator('table tr.clickable-row');
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(2); // Complete + Failed
  });

  test('Models view still shows the template model', async ({ page }) => {
    await page.goto(APP + '#/models');
    await waitForLoad(page);
    await expect(page.locator('text=New Application & Infrastructure Build')).toBeVisible();
  });
});
