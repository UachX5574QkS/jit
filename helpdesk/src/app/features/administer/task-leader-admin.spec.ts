import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TaskLeaderAdmin } from './task-leader-admin';
import type { ActiveTask, CurrentVersion, TaskView } from './task-leader-admin.service';
import { CurrentUserService } from '../../core/auth/current-user.service';
import type { CurrentUser, Role } from '../../core/auth/current-user.model';
import { errorInterceptor } from '../../core/http/error.interceptor';

/**
 * Component tests for the Team-Leader Tasks screen (task 14.2; R16, R20.4).
 * They exercise the behaviours the task calls out: list a led team's active
 * tasks, create a task (with fields + support notes), create a NEW version of a
 * task (version pinning, R16.4), the override constraint (name/data type are
 * NOT overridable, R16.3), and retire a task (R16.6/R20.4). Server-side
 * leadership enforcement is surfaced gracefully (FORBIDDEN).
 */

const TEAM_ID = 5;

function makeUser(teamsLed: number[] = [TEAM_ID]): CurrentUser {
  const roles: Role[] = ['USER', 'TEAM_LEADER'];
  return {
    id: 1,
    username: '11111111',
    displayName: 'Team Leader',
    roles: new Set<Role>(roles),
    teamsLed,
    teamsMemberOf: [],
    isAdmin: false,
    timezone: null,
  };
}

const TASKS: ActiveTask[] = [
  { id: 10, teamId: TEAM_ID, name: 'New starter access' },
  { id: 11, teamId: TEAM_ID, name: 'Password reset' },
];

function currentVersion(overrides: Partial<CurrentVersion> = {}): CurrentVersion {
  return {
    taskId: 10,
    taskName: 'New starter access',
    teamId: TEAM_ID,
    versionId: 100,
    versionNo: 1,
    supportNotes: 'Check the joiner ticket first.',
    fields: [
      {
        taskFieldId: 1000,
        dataPointId: 7,
        fieldOrder: 0,
        name: 'Employee ID',
        dataType: 'NUMERIC',
        isMandatory: true,
        description: 'The new starter payroll id',
        helpText: 'Found on the HR record',
        options: null,
        regexpPattern: null,
      },
    ],
    ...overrides,
  };
}

function taskView(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 10,
    teamId: TEAM_ID,
    name: 'New starter access',
    isRetired: false,
    currentVersion: { id: 101, versionNo: 2, supportNotes: null, fields: [] },
    ...overrides,
  };
}

describe('TaskLeaderAdmin', () => {
  let httpMock: HttpTestingController;
  let currentUser: CurrentUserService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TaskLeaderAdmin],
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    currentUser = TestBed.inject(CurrentUserService);
  });

  /** Create the component for a leader of one team (auto-selected) and flush loads. */
  function createForSingleTeam(tasks: ActiveTask[] = TASKS) {
    currentUser.setUser(makeUser([TEAM_ID]));
    const fixture = TestBed.createComponent(TaskLeaderAdmin);
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url === '/api/teams' && r.method === 'GET')
      .flush({ teams: [{ id: TEAM_ID, title: 'Access Management', description: null }] });
    httpMock
      .expectOne((r) => r.url === `/api/teams/${TEAM_ID}/tasks` && r.method === 'GET')
      .flush({ tasks });
    fixture.detectChanges();
    return fixture;
  }

  it('lists the active tasks for the led team (R16.5)', () => {
    const fixture = createForSingleTeam();
    const el = fixture.nativeElement as HTMLElement;
    const rows = el.querySelectorAll('.task-row');
    expect(rows.length).toBe(2);
    expect(el.textContent).toContain('New starter access');
    expect(el.textContent).toContain('Password reset');
    httpMock.verify();
  });

  it('creates a task with a field and support notes (R16.1, R16.2)', () => {
    const fixture = createForSingleTeam();
    const c = fixture.componentInstance as unknown as {
      startCreate(): void;
      formName: { set(v: string): void };
      formSupportNotes: { set(v: string): void };
      newDataPointId: { set(v: string): void };
      addField(): void;
      save(): void;
    };
    c.startCreate();
    c.formName.set('Leaver offboarding');
    c.formSupportNotes.set('Revoke within 24h');
    c.newDataPointId.set('7');
    fixture.detectChanges();
    c.addField();
    fixture.detectChanges();
    c.save();

    const req = httpMock.expectOne(
      (r) => r.url === '/api/team-leader/tasks' && r.method === 'POST',
    );
    expect(req.request.body).toEqual({
      teamId: TEAM_ID,
      name: 'Leaver offboarding',
      supportNotes: 'Revoke within 24h',
      fields: [
        {
          dataPointId: 7,
          fieldOrder: 0,
          isMandatory: false,
          descriptionOverride: null,
          helpTextOverride: null,
          optionsOverride: null,
        },
      ],
    });
    req.flush(taskView({ id: 12, name: 'Leaver offboarding', currentVersion: { id: 120, versionNo: 1, supportNotes: 'Revoke within 24h', fields: [] } }));
    // The list is refreshed after the save.
    httpMock
      .expectOne((r) => r.url === `/api/teams/${TEAM_ID}/tasks` && r.method === 'GET')
      .flush({ tasks: [...TASKS, { id: 12, teamId: TEAM_ID, name: 'Leaver offboarding' }] });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.form-success')?.textContent).toContain('version 1');
    httpMock.verify();
  });

  it('creates a NEW version from the current version, preserving fields (version pinning, R16.4)', () => {
    const fixture = createForSingleTeam();
    const el = fixture.nativeElement as HTMLElement;
    // Click "Edit (new version)" on the first task.
    el.querySelectorAll<HTMLButtonElement>('.task-row .btn-ghost')[0].click();

    // The editor loads the current version to prefill.
    httpMock
      .expectOne((r) => r.url === '/api/tasks/10/current-version' && r.method === 'GET')
      .flush(currentVersion());
    fixture.detectChanges();

    const c = fixture.componentInstance as unknown as { save(): void };
    c.save();

    const req = httpMock.expectOne(
      (r) => r.url === '/api/team-leader/tasks/10' && r.method === 'PATCH',
    );
    // The prefilled field is carried into the new version at order 0, with its
    // effective description/help preserved. Name/dataType are never sent (R16.3).
    expect(req.request.body).toEqual({
      name: 'New starter access',
      supportNotes: 'Check the joiner ticket first.',
      fields: [
        {
          dataPointId: 7,
          fieldOrder: 0,
          isMandatory: true,
          descriptionOverride: 'The new starter payroll id',
          helpTextOverride: 'Found on the HR record',
          optionsOverride: null,
        },
      ],
    });
    expect(req.request.body.fields[0].name).toBeUndefined();
    expect(req.request.body.fields[0].dataType).toBeUndefined();
    req.flush(taskView({ currentVersion: { id: 102, versionNo: 2, supportNotes: null, fields: [] } }));
    httpMock
      .expectOne((r) => r.url === `/api/teams/${TEAM_ID}/tasks` && r.method === 'GET')
      .flush({ tasks: TASKS });
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('.form-success')?.textContent).toContain(
      'version 2',
    );
    httpMock.verify();
  });

  it('does not offer name or data type overrides on an existing field (R16.3)', () => {
    const fixture = createForSingleTeam();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelectorAll<HTMLButtonElement>('.task-row .btn-ghost')[0].click();
    httpMock
      .expectOne((r) => r.url === '/api/tasks/10/current-version' && r.method === 'GET')
      .flush(currentVersion());
    fixture.detectChanges();

    // The field shows its name and data type read-only (no editable input for them).
    const item = el.querySelector('.field-item')!;
    expect(item.querySelector('.field-name')?.textContent).toContain('Employee ID');
    expect(item.querySelector('.field-type')?.textContent).toContain('NUMERIC');
    // Editable controls exist for the overridable attributes only.
    const editableLabels = Array.from(item.querySelectorAll('.sub-label')).map((n) =>
      n.textContent?.trim(),
    );
    expect(editableLabels).toContain('Description override');
    expect(editableLabels).toContain('Help text override');
    expect(editableLabels.join(' ')).not.toContain('Name');
    expect(editableLabels.join(' ')).not.toContain('Data type');
    httpMock.verify();
  });

  it('sends a dropdown options override when provided (R16.2)', () => {
    const fixture = createForSingleTeam();
    const c = fixture.componentInstance as unknown as {
      startCreate(): void;
      formName: { set(v: string): void };
      newDataPointId: { set(v: string): void };
      addField(): void;
      fields(): { key: number }[];
      updateFieldOptions(key: number, value: string): void;
      save(): void;
    };
    c.startCreate();
    c.formName.set('Kit request');
    c.newDataPointId.set('9');
    c.addField();
    const key = c.fields()[0].key;
    c.updateFieldOptions(key, 'Laptop\nMonitor\n\nHeadset');
    c.save();

    const req = httpMock.expectOne(
      (r) => r.url === '/api/team-leader/tasks' && r.method === 'POST',
    );
    expect(req.request.body.fields[0].optionsOverride).toEqual(['Laptop', 'Monitor', 'Headset']);
    req.flush(taskView({ id: 13, name: 'Kit request' }));
    httpMock
      .expectOne((r) => r.url === `/api/teams/${TEAM_ID}/tasks` && r.method === 'GET')
      .flush({ tasks: TASKS });
    httpMock.verify();
  });

  it('retires a task and drops it from the active list (R16.6/R20.4)', () => {
    const fixture = createForSingleTeam();
    const el = fixture.nativeElement as HTMLElement;
    // Retire the first task.
    el.querySelectorAll<HTMLButtonElement>('.task-row .btn-danger')[0].click();

    const req = httpMock.expectOne(
      (r) => r.url === '/api/team-leader/tasks/10/retire' && r.method === 'POST',
    );
    req.flush(taskView({ isRetired: true }));
    fixture.detectChanges();

    expect(el.querySelectorAll('.task-row').length).toBe(1);
    expect(el.textContent).not.toContain('New starter access');
    httpMock.verify();
  });

  it('surfaces a validation error on save gracefully (e.g. retired data point, R16.2)', () => {
    const fixture = createForSingleTeam();
    const c = fixture.componentInstance as unknown as {
      startCreate(): void;
      formName: { set(v: string): void };
      newDataPointId: { set(v: string): void };
      addField(): void;
      save(): void;
    };
    c.startCreate();
    c.formName.set('Bad task');
    c.newDataPointId.set('99');
    c.addField();
    c.save();

    const req = httpMock.expectOne(
      (r) => r.url === '/api/team-leader/tasks' && r.method === 'POST',
    );
    req.flush(
      { error: { code: 'VALIDATION_FAILED', message: 'Data point 99 is retired and cannot be used' } },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.form-error')?.textContent).toContain('retired');
    httpMock.verify();
  });

  it('surfaces FORBIDDEN gracefully when tasks cannot be loaded for a team (R16.1)', () => {
    currentUser.setUser(makeUser([9]));
    const fixture = TestBed.createComponent(TaskLeaderAdmin);
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url === '/api/teams' && r.method === 'GET')
      .flush({ teams: [{ id: 9, title: 'Networking', description: null }] });
    httpMock
      .expectOne((r) => r.url === '/api/teams/9/tasks' && r.method === 'GET')
      .flush(
        { error: { code: 'FORBIDDEN', message: 'Requires leadership of this team' } },
        { status: 403, statusText: 'Forbidden' },
      );
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.admin-error')?.textContent).toContain('team you lead');
    httpMock.verify();
  });
});
