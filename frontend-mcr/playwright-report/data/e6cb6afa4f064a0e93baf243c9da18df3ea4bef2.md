# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mcr-lifecycle.spec.ts >> MCR Lifecycle - Full Workflow >> 4. Add a task to the MCR
- Location: e2e\mcr-lifecycle.spec.ts:107:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('text=E2E Test Task')
Expected: visible
Error: strict mode violation: locator('text=E2E Test Task') resolved to 7 elements:
    1) <span _ngcontent-ng-c3455510672="" class="task-title clickable">E2E Test Task</span> aka getByText('E2E Test Task').first()
    2) <span _ngcontent-ng-c3455510672="" class="task-title clickable">E2E Test Task</span> aka getByText('E2E Test Task').nth(1)
    3) <span _ngcontent-ng-c3455510672="" class="task-title clickable">E2E Test Task</span> aka getByText('E2E Test Task').nth(2)
    4) <span _ngcontent-ng-c3455510672="" class="task-title clickable">E2E Test Task</span> aka getByText('E2E Test Task').nth(3)
    5) <span _ngcontent-ng-c3455510672="" class="task-title clickable">E2E Test Task</span> aka getByText('E2E Test Task').nth(4)
    6) <span _ngcontent-ng-c3455510672="" class="task-title clickable">E2E Test Task</span> aka getByText('E2E Test Task').nth(5)
    7) <span _ngcontent-ng-c3455510672="" class="task-title clickable">E2E Test Task</span> aka locator('tr:nth-child(10) > .mat-mdc-cell.mdc-data-table__cell.cdk-cell.cdk-column-title > .title-cell > .task-title')

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('text=E2E Test Task')

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [ref=e3]:
    - complementary [ref=e4]:
      - generic [ref=e5]: MCR
      - navigation [ref=e8]:
        - link "Create" [ref=e9] [cursor=pointer]:
          - /url: "#/create"
          - img [ref=e10]: add_circle
        - link "Active" [ref=e12] [cursor=pointer]:
          - /url: "#/active"
          - img [ref=e13]: play_circle
        - link "Archived" [ref=e15] [cursor=pointer]:
          - /url: "#/archived"
          - img [ref=e16]: archive
        - link "Models" [ref=e18] [cursor=pointer]:
          - /url: "#/models"
          - img [ref=e19]: content_copy
        - link "Admin" [ref=e21] [cursor=pointer]:
          - /url: "#/admin"
          - img [ref=e22]: settings
    - generic [ref=e24]:
      - banner [ref=e25]:
        - heading "MCR Manager" [level=1] [ref=e26]
        - generic [ref=e31] [cursor=pointer]:
          - generic: User
          - combobox "Switch user identity" [ref=e34]
      - main [ref=e42]:
        - generic [ref=e44]:
          - generic [ref=e45]:
            - button [ref=e46] [cursor=pointer]:
              - img [ref=e47]: arrow_back
            - heading "Tasks — MCR4324" [level=2] [ref=e50]
            - button "Add Task" [active] [ref=e51]:
              - img [ref=e52]: add
          - table [ref=e58]:
            - rowgroup [ref=e59]:
              - row [ref=e60]:
                - columnheader [ref=e61] [cursor=pointer]:
                  - button "ID" [ref=e62]
                - columnheader [ref=e67] [cursor=pointer]:
                  - button "Deps" [ref=e68]
                - columnheader [ref=e73] [cursor=pointer]:
                  - button "Jira Ref" [ref=e74]
                - columnheader [ref=e79] [cursor=pointer]:
                  - button "Title" [ref=e80]
                - columnheader [ref=e85] [cursor=pointer]:
                  - button "Owning Team" [ref=e86]
                - columnheader "Specified By" [ref=e91]
                - columnheader "Actioned By" [ref=e92]
                - columnheader [ref=e93] [cursor=pointer]:
                  - button "Est Start" [ref=e94]
                - columnheader [ref=e99] [cursor=pointer]:
                  - button "Status" [ref=e100]
                - columnheader "Approval Action" [ref=e105]
                - columnheader "Status Changed By" [ref=e106]
                - columnheader "SOE" [ref=e107]
                - columnheader "Backout" [ref=e108]
                - columnheader "TCD" [ref=e109]
            - rowgroup [ref=e110]:
              - row [ref=e111] [cursor=pointer]:
                - cell "1" [ref=e112]
                - cell "—" [ref=e113]
                - cell "fsoc-1234" [ref=e114]
                - cell "fdsfs" [ref=e115]
                - cell "Engineering" [ref=e118]
                - cell "Alex Morgan" [ref=e119]
                - cell "Operations" [ref=e120]
                - cell "—" [ref=e121]
                - cell "Pending" [ref=e122]
                - cell "Pending" [ref=e124]
                - cell "Alex Morgan" [ref=e126]
                - cell [ref=e127]:
                  - img [ref=e128]: check_circle
                - cell [ref=e129]:
                  - img [ref=e130]: check_circle
                - cell [ref=e131]:
                  - img [ref=e132]: cancel
              - row [ref=e133] [cursor=pointer]:
                - cell "2" [ref=e134]
                - cell "—" [ref=e135]
                - cell "fsoc-1234" [ref=e136]
                - cell "title" [ref=e137]
                - cell "Engineering" [ref=e140]
                - cell "Alex Morgan" [ref=e141]
                - cell "Engineering" [ref=e142]
                - cell "—" [ref=e143]
                - cell "Draft" [ref=e144]
                - cell "Draft" [ref=e146]
                - cell "—" [ref=e148]
                - cell [ref=e149]:
                  - img [ref=e150]: cancel
                - cell [ref=e151]:
                  - img [ref=e152]: cancel
                - cell [ref=e153]:
                  - img [ref=e154]: cancel
              - row [ref=e155] [cursor=pointer]:
                - cell "3" [ref=e156]
                - cell "—" [ref=e157]
                - cell "fsoc-1234" [ref=e158]
                - cell "fdsfsd" [ref=e159]
                - cell "Engineering" [ref=e162]
                - cell "Alex Morgan" [ref=e163]
                - cell "Engineering" [ref=e164]
                - cell "—" [ref=e165]
                - cell "Draft" [ref=e166]
                - cell "Draft" [ref=e168]
                - cell "—" [ref=e170]
                - cell [ref=e171]:
                  - img [ref=e172]: cancel
                - cell [ref=e173]:
                  - img [ref=e174]: cancel
                - cell [ref=e175]:
                  - img [ref=e176]: cancel
              - row [ref=e177] [cursor=pointer]:
                - cell "4" [ref=e178]
                - cell "—" [ref=e179]
                - cell "—" [ref=e180]
                - cell "E2E Test Task" [ref=e181]
                - cell "—" [ref=e184]
                - cell "Alex Morgan" [ref=e185]
                - cell "Alex Morgan" [ref=e186]
                - cell "—" [ref=e187]
                - cell "Draft" [ref=e188]
                - cell [ref=e190]
                - cell "—" [ref=e191]
                - cell [ref=e192]:
                  - img [ref=e193]: cancel
                - cell [ref=e194]:
                  - img [ref=e195]: cancel
                - cell [ref=e196]:
                  - img [ref=e197]: cancel
              - row [ref=e198] [cursor=pointer]:
                - cell "5" [ref=e199]
                - cell "—" [ref=e200]
                - cell "—" [ref=e201]
                - cell "E2E Test Task" [ref=e202]
                - cell "—" [ref=e205]
                - cell "Alex Morgan" [ref=e206]
                - cell "Alex Morgan" [ref=e207]
                - cell "—" [ref=e208]
                - cell "Draft" [ref=e209]
                - cell [ref=e211]
                - cell "—" [ref=e212]
                - cell [ref=e213]:
                  - img [ref=e214]: cancel
                - cell [ref=e215]:
                  - img [ref=e216]: cancel
                - cell [ref=e217]:
                  - img [ref=e218]: cancel
              - row [ref=e219] [cursor=pointer]:
                - cell "6" [ref=e220]
                - cell "—" [ref=e221]
                - cell "—" [ref=e222]
                - cell "E2E Test Task" [ref=e223]
                - cell "—" [ref=e226]
                - cell "Alex Morgan" [ref=e227]
                - cell "Alex Morgan" [ref=e228]
                - cell "—" [ref=e229]
                - cell "Draft" [ref=e230]
                - cell [ref=e232]
                - cell "—" [ref=e233]
                - cell [ref=e234]:
                  - img [ref=e235]: cancel
                - cell [ref=e236]:
                  - img [ref=e237]: cancel
                - cell [ref=e238]:
                  - img [ref=e239]: cancel
              - row [ref=e240] [cursor=pointer]:
                - cell "7" [ref=e241]
                - cell "—" [ref=e242]
                - cell "—" [ref=e243]
                - cell "E2E Test Task" [ref=e244]
                - cell "—" [ref=e247]
                - cell "Alex Morgan" [ref=e248]
                - cell "Alex Morgan" [ref=e249]
                - cell "—" [ref=e250]
                - cell "Draft" [ref=e251]
                - cell [ref=e253]
                - cell "—" [ref=e254]
                - cell [ref=e255]:
                  - img [ref=e256]: cancel
                - cell [ref=e257]:
                  - img [ref=e258]: cancel
                - cell [ref=e259]:
                  - img [ref=e260]: cancel
              - row [ref=e261] [cursor=pointer]:
                - cell "8" [ref=e262]
                - cell "—" [ref=e263]
                - cell "—" [ref=e264]
                - cell "E2E Test Task" [ref=e265]
                - cell "—" [ref=e268]
                - cell "Alex Morgan" [ref=e269]
                - cell "Alex Morgan" [ref=e270]
                - cell "—" [ref=e271]
                - cell "Draft" [ref=e272]
                - cell [ref=e274]
                - cell "—" [ref=e275]
                - cell [ref=e276]:
                  - img [ref=e277]: cancel
                - cell [ref=e278]:
                  - img [ref=e279]: cancel
                - cell [ref=e280]:
                  - img [ref=e281]: cancel
              - row [ref=e282] [cursor=pointer]:
                - cell "9" [ref=e283]
                - cell "—" [ref=e284]
                - cell "—" [ref=e285]
                - cell "E2E Test Task" [ref=e286]
                - cell "—" [ref=e289]
                - cell "Alex Morgan" [ref=e290]
                - cell "Alex Morgan" [ref=e291]
                - cell "—" [ref=e292]
                - cell "Draft" [ref=e293]
                - cell [ref=e295]
                - cell "—" [ref=e296]
                - cell [ref=e297]:
                  - img [ref=e298]: cancel
                - cell [ref=e299]:
                  - img [ref=e300]: cancel
                - cell [ref=e301]:
                  - img [ref=e302]: cancel
              - row [ref=e303] [cursor=pointer]:
                - cell "10" [ref=e304]
                - cell "—" [ref=e305]
                - cell "—" [ref=e306]
                - cell "E2E Test Task" [ref=e307]
                - cell "—" [ref=e310]
                - cell "Alex Morgan" [ref=e311]
                - cell "Alex Morgan" [ref=e312]
                - cell "—" [ref=e313]
                - cell "Draft" [ref=e314]
                - cell [ref=e316]
                - cell "—" [ref=e317]
                - cell [ref=e318]:
                  - img [ref=e319]: cancel
                - cell [ref=e320]:
                  - img [ref=e321]: cancel
                - cell [ref=e322]:
                  - img [ref=e323]: cancel
  - generic [ref=e331]:
    - generic [ref=e332]: Task created
    - button "Close" [ref=e334]
```

# Test source

```ts
  29  |     await waitForLoad(page);
  30  | 
  31  |     // Fill form
  32  |     await page.locator('input[formcontrolname="mcrNumber"]').fill(mcr);
  33  |     await selectOption(page, 'Owner', 'Alex Morgan');
  34  |     await page.locator('textarea[formcontrolname="description"]').fill('E2E test MCR for lifecycle validation');
  35  | 
  36  |     // Set dates (today + 7 days)
  37  |     const today = new Date();
  38  |     const endDate = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  39  |     await page.locator('input[formcontrolname="startDate"]').fill(today.toISOString().split('T')[0]);
  40  |     await page.locator('input[formcontrolname="endDate"]').fill(endDate.toISOString().split('T')[0]);
  41  | 
  42  |     // RACI: Select Alex Morgan as Accountable
  43  |     await selectOption(page, 'Accountable', 'Alex Morgan');
  44  |     // Close the dropdown overlay by clicking elsewhere on the page body
  45  |     await page.locator('body').click({ position: { x: 10, y: 10 }, force: true });
  46  |     await page.waitForTimeout(500);
  47  | 
  48  |     // Save — use force click since overlay may still be fading
  49  |     await page.locator('button:has-text("Save")').click({ force: true });
  50  | 
  51  |     // Should navigate to active list or show success
  52  |     await page.waitForURL(/.*#\/active.*/, { timeout: 10000 });
  53  |     await waitForLoad(page);
  54  | 
  55  |     // Verify MCR appears in list
  56  |     await expect(page.locator(`text=${mcr}`)).toBeVisible({ timeout: 5000 });
  57  |   });
  58  | 
  59  |   test('2. Create an MCR using a Model template', async ({ page }) => {
  60  |     const modelMcr = mcrNumber();
  61  |     await page.goto(APP + '#/create');
  62  |     await waitForLoad(page);
  63  | 
  64  |     // Select the model
  65  |     await selectOption(page, 'Use Model (optional)', 'New Application & Infrastructure Build');
  66  | 
  67  |     // Fill form
  68  |     await page.locator('input[formcontrolname="mcrNumber"]').fill(modelMcr);
  69  |     await selectOption(page, 'Owner', 'Alex Morgan');
  70  |     await page.locator('textarea[formcontrolname="description"]').fill('E2E test - MCR from Model');
  71  | 
  72  |     const today = new Date();
  73  |     const endDate = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
  74  |     await page.locator('input[formcontrolname="startDate"]').fill(today.toISOString().split('T')[0]);
  75  |     await page.locator('input[formcontrolname="endDate"]').fill(endDate.toISOString().split('T')[0]);
  76  | 
  77  |     // RACI: Accountable
  78  |     await selectOption(page, 'Accountable', 'Alex Morgan');
  79  | 
  80  |     // Save
  81  |     await page.locator('body').click({ position: { x: 10, y: 10 }, force: true });
  82  |     await page.waitForTimeout(500);
  83  |     await page.locator('button:has-text("Save")').click({ force: true });
  84  | 
  85  |     // Should navigate away with snackbar message about tasks created from model
  86  |     await page.waitForURL(/.*#\/active.*/, { timeout: 15000 });
  87  |     await waitForLoad(page);
  88  | 
  89  |     // Verify the model MCR exists and has tasks
  90  |     await expect(page.locator(`text=${modelMcr}`)).toBeVisible({ timeout: 5000 });
  91  |   });
  92  | 
  93  |   test('3. Navigate to task detail and verify tasks exist', async ({ page }) => {
  94  |     await page.goto(APP);
  95  |     await waitForLoad(page);
  96  | 
  97  |     // Click first MCR row to view tasks
  98  |     const mcrRow = page.locator(`text=${mcr}`).first();
  99  |     if (await mcrRow.isVisible()) {
  100 |       // Get to task detail via the row
  101 |       await page.locator('table.mcr-table tr.clickable-row').first().click();
  102 |       await waitForLoad(page);
  103 |       await expect(page.locator('h2')).toContainText('Tasks');
  104 |     }
  105 |   });
  106 | 
  107 |   test('4. Add a task to the MCR', async ({ page }) => {
  108 |     await page.goto(APP);
  109 |     await waitForLoad(page);
  110 | 
  111 |     // Navigate to first MCR's tasks
  112 |     await page.locator('table.mcr-table tr.clickable-row').first().click();
  113 |     await waitForLoad(page);
  114 | 
  115 |     // Click Add Task
  116 |     await page.locator('button:has-text("Add Task")').click();
  117 |     await expect(page.locator('mat-dialog-container')).toBeVisible({ timeout: 5000 });
  118 | 
  119 |     // Fill task form
  120 |     await page.locator('mat-dialog-container input[formcontrolname="title"]').fill('E2E Test Task');
  121 |     await page.locator('mat-dialog-container textarea[formcontrolname="description"]').fill('Task created by Playwright E2E test');
  122 | 
  123 |     // Save
  124 |     await page.locator('mat-dialog-container button:has-text("Save")').click();
  125 | 
  126 |     // Wait for dialog to close and task to appear
  127 |     await page.waitForSelector('mat-dialog-container', { state: 'hidden', timeout: 10000 });
  128 |     await waitForLoad(page);
> 129 |     await expect(page.locator('text=E2E Test Task')).toBeVisible({ timeout: 5000 });
      |                                                      ^ Error: expect(locator).toBeVisible() failed
  130 |   });
  131 | 
  132 |   test('5. Verify dependency map loads for MCR', async ({ page }) => {
  133 |     await page.goto(APP);
  134 |     await waitForLoad(page);
  135 | 
  136 |     // Click dependency map button on first MCR
  137 |     const mapBtn = page.locator('button[mattooltip="Dependency Map"]').first();
  138 |     if (await mapBtn.isVisible()) {
  139 |       await mapBtn.click();
  140 |       await expect(page.locator('mat-dialog-container')).toBeVisible({ timeout: 5000 });
  141 |       await expect(page.locator('mat-dialog-container h2')).toContainText('Dependency Map');
  142 | 
  143 |       // Should NOT show error
  144 |       const error = page.locator('.error-text');
  145 |       await expect(error).not.toBeVisible({ timeout: 3000 }).catch(() => {});
  146 | 
  147 |       // Close
  148 |       await page.locator('mat-dialog-container button:has-text("Close")').click();
  149 |     }
  150 |   });
  151 | 
  152 |   test('6. Verify archived MCRs are accessible', async ({ page }) => {
  153 |     await page.goto(APP + '#/archived');
  154 |     await waitForLoad(page);
  155 |     await expect(page.locator('h2')).toContainText('Archived MCRs');
  156 | 
  157 |     // If there are archived MCRs, verify drill-in works
  158 |     const rows = page.locator('table tr.clickable-row');
  159 |     if (await rows.count() > 0) {
  160 |       await rows.first().click();
  161 |       await waitForLoad(page);
  162 |       await expect(page.locator('h2')).toContainText('Tasks');
  163 |     }
  164 |   });
  165 | });
  166 | 
  167 | test.describe.serial('MCR Lifecycle - API-Driven Workflow', () => {
  168 |   // These tests use the API directly to test the full lifecycle
  169 |   // since UI interactions for approval/start/complete require specific MCR states
  170 | 
  171 |   let mcrId: number;
  172 |   let taskId1: number;
  173 |   let taskId2: number;
  174 |   const mcr = mcrNumber();
  175 | 
  176 |   test('1. Create MCR via API', async ({ request }) => {
  177 |     const res = await request.post(`${API}/requests/`, {
  178 |       headers: { 'Content-Type': 'application/json' },
  179 |       data: {
  180 |         mcr_number: mcr,
  181 |         owner_user_id: 1,
  182 |         description: 'API lifecycle test',
  183 |         start_date: new Date().toISOString().split('T')[0],
  184 |         end_date: new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
  185 |         raci: JSON.stringify([{ user_id: 1, role: 'Accountable', type: 'USER' }]),
  186 |         user_id: 1
  187 |       }
  188 |     });
  189 |     expect(res.ok()).toBeTruthy();
  190 |     const body = await res.json();
  191 |     mcrId = body.mcr_id;
  192 |     expect(mcrId).toBeGreaterThan(0);
  193 |     expect(body.status).toBe('Draft');
  194 |   });
  195 | 
  196 |   test('2. Add Task 1 (no dependencies)', async ({ request }) => {
  197 |     const res = await request.post(`${API}/tasks/mcr/${mcrId}`, {
  198 |       headers: { 'Content-Type': 'application/json' },
  199 |       data: {
  200 |         user_id: 1,
  201 |         title: 'Infrastructure Setup',
  202 |         description: 'Set up cloud infrastructure',
  203 |         owner_dept_id: 100,
  204 |         implementor_id: 1,
  205 |         implementor_type: 'USER',
  206 |         sub_actions: 'Step 1: Create VPC\nStep 2: Configure subnets',
  207 |         backout_plan: 'Delete all resources',
  208 |         estimated_duration_mins: 60
  209 |       }
  210 |     });
  211 |     expect(res.ok()).toBeTruthy(); // ORDS returns 200 for POST
  212 |     const body = await res.json();
  213 |     taskId1 = body.task_id;
  214 |     expect(taskId1).toBeGreaterThan(0);
  215 |   });
  216 | 
  217 |   test('3. Add Task 2 (hard dependency on Task 1)', async ({ request }) => {
  218 |     const res = await request.post(`${API}/tasks/mcr/${mcrId}`, {
  219 |       headers: { 'Content-Type': 'application/json' },
  220 |       data: {
  221 |         user_id: 1,
  222 |         title: 'Deploy Application',
  223 |         description: 'Deploy app to infrastructure',
  224 |         owner_dept_id: 100,
  225 |         implementor_id: 1,
  226 |         implementor_type: 'USER',
  227 |         hard_deps_csv: String(taskId1),
  228 |         sub_actions: 'Step 1: Build\nStep 2: Deploy',
  229 |         backout_plan: 'Rollback deployment',
```