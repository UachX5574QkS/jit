import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { NewWorkflow } from './new-workflow';

/**
 * Component tests for the New workflow wizard (R2, R3). They exercise the
 * behaviours the task calls out: the team→task cascade (R2.3), mandatory/type
 * gating blocking the Step 2 advance (R2.10, R3), the Ollama fallback (R2.12),
 * and a successful submit + navigation (R2.14).
 */

const TEAMS = {
  teams: [
    { id: 1, title: 'Platform', description: null },
    { id: 2, title: 'Data', description: 'Data team' },
  ],
};

const TASKS_TEAM_1 = {
  tasks: [
    { id: 10, teamId: 1, name: 'Access request' },
    { id: 11, teamId: 1, name: 'New environment' },
  ],
};

const CURRENT_VERSION_10 = {
  taskId: 10,
  taskName: 'Access request',
  teamId: 1,
  versionId: 500,
  versionNo: 3,
  supportNotes: null,
  fields: [
    {
      taskFieldId: 90,
      dataPointId: 1,
      fieldOrder: 2,
      name: 'Reason',
      dataType: 'TEXT',
      isMandatory: true,
      description: null,
      helpText: 'Why you need access',
      options: null,
      regexpPattern: null,
    },
    {
      taskFieldId: 91,
      dataPointId: 2,
      fieldOrder: 1,
      name: 'Contact Email',
      dataType: 'EMAIL',
      isMandatory: true,
      description: null,
      helpText: null,
      options: null,
      regexpPattern: null,
    },
  ],
};

describe('NewWorkflow', () => {
  let httpMock: HttpTestingController;
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NewWorkflow],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  });

  /** Create the component and satisfy the initial open-teams load. */
  function create(teams: typeof TEAMS = TEAMS) {
    const fixture = TestBed.createComponent(NewWorkflow);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.url === '/api/teams').flush(teams);
    fixture.detectChanges();
    return fixture;
  }

  type Comp = NewWorkflow & {
    step(): 1 | 2 | 3;
    onTeamChange(v: string): void;
    onTaskChange(v: string): void;
    canLeaveStep1(): boolean;
    canLeaveStep2(): boolean;
    next(): void;
    submit(): void;
    tasks(): unknown[];
    form(): { get(name: string): { setValue(v: unknown): void } | null } | null;
    summary(): unknown;
  };

  function comp(fixture: ReturnType<typeof create>): Comp {
    return fixture.componentInstance as unknown as Comp;
  }

  it('loads open teams on init (R2.3)', () => {
    const fixture = create();
    const c = comp(fixture);
    expect(c.step()).toBe(1);
    httpMock.verify();
  });

  it('cascades team → task: selecting a team loads its active tasks (R2.3)', () => {
    const fixture = create();
    const c = comp(fixture);

    c.onTeamChange('1');
    const tasksReq = httpMock.expectOne((r) => r.url === '/api/teams/1/tasks');
    expect(tasksReq.request.params.get('active')).toBe('true');
    tasksReq.flush(TASKS_TEAM_1);
    fixture.detectChanges();

    expect(c.tasks().length).toBe(2);
    // Next is blocked until BOTH team and task are chosen (R2.4).
    expect(c.canLeaveStep1()).toBe(false);
    c.onTaskChange('10');
    expect(c.canLeaveStep1()).toBe(true);
    httpMock.verify();
  });

  it('blocks advancing from Step 2 until mandatory + typed fields are valid (R2.10, R3)', () => {
    const fixture = create();
    const c = comp(fixture);

    c.onTeamChange('1');
    httpMock.expectOne((r) => r.url === '/api/teams/1/tasks').flush(TASKS_TEAM_1);
    c.onTaskChange('10');
    c.next();

    // Load the pinned current version → build Step 2 form.
    httpMock.expectOne((r) => r.url === '/api/tasks/10/current-version').flush(CURRENT_VERSION_10);
    fixture.detectChanges();
    expect(c.step()).toBe(2);

    // Empty mandatory fields → cannot advance; next() stays on Step 2.
    expect(c.canLeaveStep2()).toBe(false);
    c.next();
    httpMock.expectNone((r) => r.url === '/api/review/summary');
    expect(c.step()).toBe(2);

    // An invalid email still blocks (type gating, R3), even with the rest filled.
    const form = c.form()!;
    form.get('title')!.setValue('Need prod access');
    form.get('90')!.setValue('a valid reason');
    form.get('91')!.setValue('not-an-email');
    expect(c.canLeaveStep2()).toBe(false);

    // Fix the email → now every mandatory field is filled and valid → can advance.
    form.get('91')!.setValue('user@example.com');
    expect(c.canLeaveStep2()).toBe(true);
    httpMock.verify();
  });

  it('falls back to entered values when the summary is unavailable (R2.12)', () => {
    const fixture = create();
    const c = comp(fixture);

    c.onTeamChange('1');
    httpMock.expectOne((r) => r.url === '/api/teams/1/tasks').flush(TASKS_TEAM_1);
    c.onTaskChange('10');
    c.next();
    httpMock.expectOne((r) => r.url === '/api/tasks/10/current-version').flush(CURRENT_VERSION_10);
    fixture.detectChanges();

    const form = c.form()!;
    form.get('title')!.setValue('Need prod access');
    form.get('90')!.setValue('deploy hotfix');
    form.get('91')!.setValue('user@example.com');
    c.next();

    // Server returns {available:false} → the wizard shows the fallback values.
    const summaryReq = httpMock.expectOne((r) => r.url === '/api/review/summary');
    summaryReq.flush({
      available: false,
      taskVersionId: 500,
      values: [
        { taskFieldId: 90, name: 'Reason', value: 'deploy hotfix' },
        { taskFieldId: 91, name: 'Contact Email', value: 'user@example.com' },
      ],
    });
    fixture.detectChanges();

    expect(c.step()).toBe(3);
    const summary = c.summary() as { available: boolean };
    expect(summary.available).toBe(false);
    // Submit is not blocked by the fallback (R2.12).
    const submitBtn = (fixture.nativeElement as HTMLElement).querySelector(
      '.workflow-actions-right .btn-primary',
    ) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    httpMock.verify();
  });

  it('submits and navigates to the created request on success (R2.14)', () => {
    const fixture = create();
    const c = comp(fixture);

    c.onTeamChange('1');
    httpMock.expectOne((r) => r.url === '/api/teams/1/tasks').flush(TASKS_TEAM_1);
    c.onTaskChange('10');
    c.next();
    httpMock.expectOne((r) => r.url === '/api/tasks/10/current-version').flush(CURRENT_VERSION_10);
    fixture.detectChanges();

    const form = c.form()!;
    form.get('title')!.setValue('Need prod access');
    form.get('90')!.setValue('deploy hotfix');
    form.get('91')!.setValue('user@example.com');
    form.get('jira')!.setValue('JIRA-42');
    c.next();

    httpMock.expectOne((r) => r.url === '/api/review/summary').flush({
      available: true,
      taskVersionId: 500,
      summary: 'A concise summary.',
    });
    fixture.detectChanges();

    c.submit();
    const createReq = httpMock.expectOne((r) => r.url === '/api/requests');
    expect(createReq.request.method).toBe('POST');
    expect(createReq.request.body).toEqual({
      taskId: 10,
      title: 'Need prod access',
      jiraNumber: 'JIRA-42',
      // Fields are submitted in fieldOrder (91 = order 1, 90 = order 2).
      fieldValues: [
        { taskFieldId: 91, value: 'user@example.com' },
        { taskFieldId: 90, value: 'deploy hotfix' },
      ],
    });
    createReq.flush({
      id: 777,
      taskReference: 'REQ-777',
      taskVersionId: 500,
      title: 'Need prod access',
      status: 'NEW',
    });

    expect(router.navigateByUrl).toHaveBeenCalledWith('/requests/777');
    httpMock.verify();
  });
});
