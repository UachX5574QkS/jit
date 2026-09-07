import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { errorInterceptor } from '../../core/http/error.interceptor';
import { CurrentUserService } from '../../core/auth/current-user.service';
import type { CurrentUser } from '../../core/auth/current-user.model';
import { SupportDetail } from './support-detail';
import type { Status } from './status-transitions';
import type {
  AuditEntry,
  MyTimers,
  OpenTimer,
  RequestDetail as RequestDetailModel,
  RequestFieldDetail,
  RequestNote,
  TeamMember,
} from './support-detail.service';

/**
 * Component tests for the SUPPORT-side DETAIL view (task 12.2; R7, R9). They
 * exercise the behaviours the task calls out:
 *   • field edit + save (R7.1);
 *   • legal-transition-only status control + INVALID_TRANSITION handling (R9);
 *   • assignment change (R7.2);
 *   • internal vs external note add (R7.3);
 *   • the audit trail shows internal-note entries (R17.4).
 */

const TEAM_ID = 7;
const RAISER_ID = 100;
const SUPPORT_ID = 200;

function field(overrides: Partial<RequestFieldDetail> = {}): RequestFieldDetail {
  return {
    taskFieldId: 1,
    dataPointId: 1,
    fieldOrder: 1,
    name: 'Summary',
    dataType: 'TEXT',
    isMandatory: true,
    description: null,
    helpText: null,
    options: null,
    regexpPattern: null,
    value: 'Original value',
    ...overrides,
  };
}

function note(overrides: Partial<RequestNote> = {}): RequestNote {
  return {
    id: 1,
    authorId: SUPPORT_ID,
    isInternal: false,
    body: 'An external note',
    createdAt: '2026-02-05T10:00:00.000Z',
    ...overrides,
  };
}

function audit(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 1,
    entityType: 'request',
    entityId: 5,
    fieldName: 'status',
    oldValue: 'NEW',
    newValue: 'TRIAGE',
    changedById: SUPPORT_ID,
    changedAt: '2026-02-05T11:00:00.000Z',
    ...overrides,
  };
}

function detail(overrides: Partial<RequestDetailModel> = {}): RequestDetailModel {
  return {
    id: 5,
    taskReference: 'REQ-5',
    taskVersionId: 10,
    taskId: 3,
    taskName: 'Access Request',
    versionNo: 1,
    title: 'Need access',
    raisedById: RAISER_ID,
    teamId: TEAM_ID,
    assignedMemberId: null,
    status: 'NEW',
    jiraNumber: null,
    estimatedStartDate: null,
    actualStartDate: null,
    createdAt: '2026-02-05T09:00:00.000Z',
    updatedAt: '2026-02-05T09:30:00.000Z',
    fields: [field()],
    notes: [note()],
    auditTrail: [audit()],
    ...overrides,
  };
}

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return { userId: 201, username: '20000201', displayName: 'Ada Lovelace', ...overrides };
}

function timer(overrides: Partial<OpenTimer> = {}): OpenTimer {
  return { id: 1, requestId: 5, memberId: SUPPORT_ID, startedAt: '2026-02-05T10:00:00.000Z', ...overrides };
}

function makeUser(id: number): CurrentUser {
  return {
    id,
    username: '20000000',
    displayName: 'Support User',
    roles: new Set(['USER', 'SUPPORT_MEMBER']),
    teamsLed: [],
    teamsMemberOf: [TEAM_ID],
    isAdmin: false,
    timezone: null,
  };
}

type Comp = SupportDetail & {
  detail(): RequestDetailModel | null;
  editing(): boolean;
  formValid(): boolean;
  noteBody(): string;
  noteInternal(): boolean;
  notes(): readonly RequestNote[];
  auditTrail(): readonly AuditEntry[];
  nextStatuses(): readonly Status[];
  teamMembers(): readonly TeamMember[];
  canSave(): boolean;
  canAddNote(): boolean;
  actionError(): string | null;
  startEdit(): void;
  save(): void;
  changeStatus(next: string): void;
  changeAssignment(raw: string): void;
  onNoteInput(v: string): void;
  setNoteInternal(v: boolean): void;
  addNote(): void;
  form(): { get(name: string): { setValue(v: unknown): void } | null } | null;
  // Timer (R8)
  myOpenTimer(): OpenTimer | null;
  otherOpenTimers(): readonly OpenTimer[];
  timerBusy(): boolean;
  timerError(): string | null;
  concurrentPrompt(): { readonly others: readonly OpenTimer[] } | null;
  durationPrompt(): { startedAt: string; elapsedMinutes: number; minutes: number; error: string | null } | null;
  showWorkingOnIt(): boolean;
  showBackToQueue(): boolean;
  hasOpenTimer(): boolean;
  isActive(): boolean;
  durationSummary(): string;
  workOnIt(): void;
  resolveConcurrent(stopOthers: boolean): void;
  cancelConcurrent(): void;
  backToQueue(): void;
  onDurationInput(raw: string): void;
  cancelDuration(): void;
  confirmDuration(): void;
};

describe('SupportDetail (task 12.2; R7, R9)', () => {
  let httpMock: HttpTestingController;
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SupportDetail],
      providers: [
        provideRouter([]),
        // Register the error interceptor so a failed API response arrives as the
        // uniform ApiError the component branches on (e.g. INVALID_TRANSITION).
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ id: '5' })) },
        },
        {
          provide: CurrentUserService,
          useValue: {
            snapshot: () => makeUser(SUPPORT_ID),
            user: signal(makeUser(SUPPORT_ID)),
          },
        },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
  });

  const NO_TIMERS: MyTimers = { onThisRequest: [], others: [] };

  /**
   * Flush the two side-loads that follow every detail load: the team members
   * (R7.2) and the member's timers on this request (R8.8).
   */
  function flushSideLoads(
    teamId: number,
    members: TeamMember[] = [member()],
    timers: MyTimers = NO_TIMERS,
  ): void {
    httpMock.expectOne(`/api/support/teams/${teamId}/members`).flush({ members });
    httpMock.expectOne('/api/requests/5/timers/mine').flush(timers);
  }

  /** Create the component and flush the initial detail + side-loads. */
  function create(
    model: RequestDetailModel = detail(),
    members: TeamMember[] = [member()],
    timers: MyTimers = NO_TIMERS,
  ) {
    const fixture = TestBed.createComponent(SupportDetail);
    fixture.detectChanges();
    const req = httpMock.expectOne('/api/requests/5');
    expect(req.request.method).toBe('GET');
    req.flush(model);
    fixture.detectChanges();
    // After the detail loads the component fetches the team's members and the
    // member's timers on this request.
    flushSideLoads(model.teamId, members, timers);
    fixture.detectChanges();
    return fixture;
  }

  function comp(fixture: ReturnType<typeof create>): Comp {
    return fixture.componentInstance as unknown as Comp;
  }

  it('loads the request detail and team members on init (R7.1, R7.2)', () => {
    const fixture = create();
    const c = comp(fixture);
    expect(c.detail()?.taskReference).toBe('REQ-5');
    expect(c.teamMembers().map((m) => m.userId)).toEqual([201]);
    httpMock.verify();
  });

  it('shows BOTH internal and external notes to support (R7.4)', () => {
    const fixture = create(
      detail({
        notes: [
          note({ id: 1, body: 'Visible external note', isInternal: false }),
          note({ id: 2, body: 'Internal-only note', isInternal: true }),
        ],
      }),
    );
    const c = comp(fixture);
    expect(c.notes().map((n) => n.id)).toEqual([1, 2]);
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('Visible external note');
    expect(html).toContain('Internal-only note');
    httpMock.verify();
  });

  it('renders internal-note audit entries for support (R17.4)', () => {
    const fixture = create(
      detail({
        auditTrail: [audit({ id: 9, fieldName: 'request_note', oldValue: null, newValue: 'internal note added' })],
      }),
    );
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.audit-field')?.textContent?.trim()).toBe('request_note');
    httpMock.verify();
  });

  // ── Field edit + save (R7.1) ──────────────────────────────────────────────

  it('gates Save on mandatory-not-blankable in the edit form (R7.1)', () => {
    const fixture = create(detail({ fields: [field({ taskFieldId: 1, isMandatory: true })] }));
    const c = comp(fixture);

    c.startEdit();
    fixture.detectChanges();
    expect(c.editing()).toBe(true);
    expect(c.canSave()).toBe(true);

    c.form()?.get('1')?.setValue('');
    fixture.detectChanges();
    expect(c.formValid()).toBe(false);
    expect(c.canSave()).toBe(false);
    httpMock.verify();
  });

  it('PATCHes fields, jira and start dates on save and reloads (R7.1)', () => {
    const fixture = create(detail({ jiraNumber: null, fields: [field({ taskFieldId: 1 })] }));
    const c = comp(fixture);

    c.startEdit();
    c.form()?.get('1')?.setValue('Updated value');
    c.form()?.get('jira')?.setValue('JIRA-9');
    c.form()?.get('estimatedStartDate')?.setValue('2026-03-01');
    fixture.detectChanges();
    c.save();

    const patch = httpMock.expectOne('/api/requests/5');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body.jiraNumber).toBe('JIRA-9');
    expect(patch.request.body.estimatedStartDate).toBe('2026-03-01');
    expect(patch.request.body.fieldValues).toContainEqual({
      taskFieldId: 1,
      value: 'Updated value',
    });
    patch.flush({});

    // Save reloads the detail (and re-fetches members).
    httpMock.expectOne('/api/requests/5').flush(detail());
    httpMock.expectOne(`/api/support/teams/${TEAM_ID}/members`).flush({ members: [member()] });
    httpMock.expectOne('/api/requests/5/timers/mine').flush(NO_TIMERS);
    httpMock.verify();
  });

  // ── Status via the state machine (R9) ──────────────────────────────────────

  it('offers only the legal next statuses for the current status (R9)', () => {
    const fixture = create(detail({ status: 'ACTIVE' }));
    const c = comp(fixture);
    // ACTIVE → COMPLETE | PAUSED | BLOCKED | CANCELLED (R9.4–9.6).
    expect([...c.nextStatuses()].sort()).toEqual(
      ['BLOCKED', 'CANCELLED', 'COMPLETE', 'PAUSED'].sort(),
    );
    httpMock.verify();
  });

  it('offers no status transitions from a closed request (R9.3)', () => {
    const fixture = create(detail({ status: 'COMPLETE' }));
    const c = comp(fixture);
    expect(c.nextStatuses()).toEqual([]);
    httpMock.verify();
  });

  it('PATCHes a chosen status and reloads (R9)', () => {
    const fixture = create(detail({ status: 'NEW' }));
    const c = comp(fixture);
    c.changeStatus('TRIAGE');

    const patch = httpMock.expectOne('/api/requests/5');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ status: 'TRIAGE' });
    patch.flush({});

    httpMock.expectOne('/api/requests/5').flush(detail({ status: 'TRIAGE' }));
    httpMock.expectOne(`/api/support/teams/${TEAM_ID}/members`).flush({ members: [member()] });
    httpMock.expectOne('/api/requests/5/timers/mine').flush(NO_TIMERS);
    httpMock.verify();
  });

  it('handles INVALID_TRANSITION gracefully and reloads (R9.7)', () => {
    const fixture = create(detail({ status: 'NEW' }));
    const c = comp(fixture);
    c.changeStatus('TRIAGE');

    const patch = httpMock.expectOne('/api/requests/5');
    patch.flush(
      { error: { code: 'INVALID_TRANSITION', message: 'Cannot move a request from NEW to TRIAGE' } },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();

    // The action error is surfaced and the detail is reloaded.
    expect(c.actionError()).toContain('no longer allowed');
    httpMock.expectOne('/api/requests/5').flush(detail({ status: 'TRIAGE' }));
    httpMock.expectOne(`/api/support/teams/${TEAM_ID}/members`).flush({ members: [member()] });
    httpMock.expectOne('/api/requests/5/timers/mine').flush(NO_TIMERS);
    httpMock.verify();
  });

  // ── Assignment (R7.2) ───────────────────────────────────────────────────────

  it('PATCHes an assignment change to a team member and reloads (R7.2)', () => {
    const fixture = create(detail({ assignedMemberId: null }), [
      member({ userId: 201, displayName: 'Ada Lovelace' }),
      member({ userId: 202, displayName: 'Grace Hopper' }),
    ]);
    const c = comp(fixture);
    c.changeAssignment('202');

    const patch = httpMock.expectOne('/api/requests/5');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ assignedMemberId: 202 });
    patch.flush({});

    httpMock.expectOne('/api/requests/5').flush(detail({ assignedMemberId: 202 }));
    httpMock.expectOne(`/api/support/teams/${TEAM_ID}/members`).flush({ members: [member()] });
    httpMock.expectOne('/api/requests/5/timers/mine').flush(NO_TIMERS);
    httpMock.verify();
  });

  it('PATCHes an unassign (null) and reloads (R7.2)', () => {
    const fixture = create(detail({ assignedMemberId: 201 }));
    const c = comp(fixture);
    c.changeAssignment('');

    const patch = httpMock.expectOne('/api/requests/5');
    expect(patch.request.body).toEqual({ assignedMemberId: null });
    patch.flush({});

    httpMock.expectOne('/api/requests/5').flush(detail({ assignedMemberId: null }));
    httpMock.expectOne(`/api/support/teams/${TEAM_ID}/members`).flush({ members: [member()] });
    httpMock.expectOne('/api/requests/5/timers/mine').flush(NO_TIMERS);
    httpMock.verify();
  });

  it('ignores an assignment change that is a no-op (R7.2)', () => {
    const fixture = create(detail({ assignedMemberId: 201 }));
    const c = comp(fixture);
    // Selecting the already-assigned member must not fire a PATCH.
    c.changeAssignment('201');
    httpMock.verify(); // no outstanding requests
  });

  // ── Notes: internal vs external (R7.3) ──────────────────────────────────────

  it('adds an EXTERNAL note by default and reloads (R7.3, R7.6)', () => {
    const fixture = create();
    const c = comp(fixture);

    expect(c.canAddNote()).toBe(false);
    c.onNoteInput('Visible to the raiser');
    fixture.detectChanges();
    expect(c.canAddNote()).toBe(true);
    expect(c.noteInternal()).toBe(false);

    c.addNote();
    const post = httpMock.expectOne('/api/requests/5/notes');
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({ body: 'Visible to the raiser', isInternal: false });
    post.flush({
      id: 2,
      requestId: 5,
      authorId: SUPPORT_ID,
      isInternal: false,
      body: 'Visible to the raiser',
      createdAt: '2026-02-05T12:00:00.000Z',
    });

    httpMock.expectOne('/api/requests/5').flush(detail());
    httpMock.expectOne(`/api/support/teams/${TEAM_ID}/members`).flush({ members: [member()] });
    httpMock.expectOne('/api/requests/5/timers/mine').flush(NO_TIMERS);
    fixture.detectChanges();
    expect(c.noteBody()).toBe('');
    httpMock.verify();
  });

  it('adds an INTERNAL note when marked internal (R7.3, R7.5)', () => {
    const fixture = create();
    const c = comp(fixture);

    c.onNoteInput('Support-only note');
    c.setNoteInternal(true);
    fixture.detectChanges();

    c.addNote();
    const post = httpMock.expectOne('/api/requests/5/notes');
    expect(post.request.body).toEqual({ body: 'Support-only note', isInternal: true });
    post.flush({
      id: 3,
      requestId: 5,
      authorId: SUPPORT_ID,
      isInternal: true,
      body: 'Support-only note',
      createdAt: '2026-02-05T13:00:00.000Z',
    });

    httpMock.expectOne('/api/requests/5').flush(detail());
    httpMock.expectOne(`/api/support/teams/${TEAM_ID}/members`).flush({ members: [member()] });
    httpMock.expectOne('/api/requests/5/timers/mine').flush(NO_TIMERS);
    httpMock.verify();
  });

  // ── Timer UI: "Working on It" / "Back to Queue" (task 12.3; R8) ──────────────

  it('shows "Working on It" ONLY when ACTIVE and no open timer (R8.1)', () => {
    // Not ACTIVE → no button.
    const notActive = create(detail({ status: 'ASSIGNED' }));
    expect(comp(notActive).showWorkingOnIt()).toBe(false);
    expect(comp(notActive).showBackToQueue()).toBe(false);
  });

  it('shows "Working on It" when ACTIVE with no open timer (R8.1)', () => {
    const fixture = create(detail({ status: 'ACTIVE' }));
    const c = comp(fixture);
    expect(c.isActive()).toBe(true);
    expect(c.hasOpenTimer()).toBe(false);
    expect(c.showWorkingOnIt()).toBe(true);
    expect(c.showBackToQueue()).toBe(false);
    httpMock.verify();
  });

  it('shows "Back to Queue" (not "Working on It") when a timer is open on this request (R8.3)', () => {
    const fixture = create(detail({ status: 'ACTIVE' }), [member()], {
      onThisRequest: [timer()],
      others: [],
    });
    const c = comp(fixture);
    expect(c.hasOpenTimer()).toBe(true);
    expect(c.showBackToQueue()).toBe(true);
    expect(c.showWorkingOnIt()).toBe(false);
    // The "(Working On)" state is reflected on the status pill.
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('(Working On)');
    httpMock.verify();
  });

  it('starts a timer without a status change and reflects the open timer (R8.2)', () => {
    const fixture = create(detail({ status: 'ACTIVE' }));
    const c = comp(fixture);

    c.workOnIt();
    const start = httpMock.expectOne('/api/requests/5/timer/start');
    expect(start.request.method).toBe('POST');
    expect(start.request.body).toEqual({});
    start.flush({ timer: timer(), otherOpenTimers: [], stoppedOthers: false });
    fixture.detectChanges();

    expect(c.hasOpenTimer()).toBe(true);
    expect(c.showBackToQueue()).toBe(true);
    httpMock.verify();
  });

  it('opens the concurrent-timer prompt when the member has timers on OTHER requests (R8.8)', () => {
    const other = timer({ id: 2, requestId: 900 });
    const fixture = create(detail({ status: 'ACTIVE' }), [member()], {
      onThisRequest: [],
      others: [other],
    });
    const c = comp(fixture);

    c.workOnIt();
    // No start yet — the prompt is shown first (R8.8).
    httpMock.verify();
    expect(c.concurrentPrompt()?.others.map((t) => t.requestId)).toEqual([900]);
  });

  it('resolves the concurrent prompt by STOPPING the others (stopOthers:true) (R8.8)', () => {
    const other = timer({ id: 2, requestId: 900 });
    const fixture = create(detail({ status: 'ACTIVE' }), [member()], {
      onThisRequest: [],
      others: [other],
    });
    const c = comp(fixture);

    c.workOnIt();
    c.resolveConcurrent(true);

    const start = httpMock.expectOne('/api/requests/5/timer/start');
    expect(start.request.body).toEqual({ stopOthers: true });
    start.flush({ timer: timer(), otherOpenTimers: [other], stoppedOthers: true });
    fixture.detectChanges();

    expect(c.concurrentPrompt()).toBeNull();
    expect(c.hasOpenTimer()).toBe(true);
    // The others were stopped, so they no longer count as open.
    expect(c.otherOpenTimers()).toEqual([]);
    httpMock.verify();
  });

  it('resolves the concurrent prompt by LEAVING the others running (stopOthers:false) (R8.8)', () => {
    const other = timer({ id: 2, requestId: 900 });
    const fixture = create(detail({ status: 'ACTIVE' }), [member()], {
      onThisRequest: [],
      others: [other],
    });
    const c = comp(fixture);

    c.workOnIt();
    c.resolveConcurrent(false);

    const start = httpMock.expectOne('/api/requests/5/timer/start');
    expect(start.request.body).toEqual({ stopOthers: false });
    start.flush({ timer: timer(), otherOpenTimers: [other], stoppedOthers: false });
    fixture.detectChanges();

    expect(c.concurrentPrompt()).toBeNull();
    expect(c.hasOpenTimer()).toBe(true);
    // The others were left running and are still reported.
    expect(c.otherOpenTimers().map((t) => t.requestId)).toEqual([900]);
    httpMock.verify();
  });

  it('"Back to Queue" opens the duration pop-up pre-filled with the elapsed time (R8.4)', () => {
    // A timer started 90 minutes ago → 1h 30m.
    const startedAt = new Date(Date.now() - 90 * 60_000).toISOString();
    const fixture = create(detail({ status: 'ACTIVE' }), [member()], {
      onThisRequest: [timer({ startedAt })],
      others: [],
    });
    const c = comp(fixture);

    c.backToQueue();
    fixture.detectChanges();
    const prompt = c.durationPrompt();
    expect(prompt).not.toBeNull();
    expect(prompt!.minutes).toBe(90);
    expect(c.durationSummary()).toBe('1h 30m');
    // No stop call until confirmed.
    httpMock.verify();
  });

  it('confirming an UNEDITED duration records the slice without a durationMinutes override (R8.6)', () => {
    const startedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const fixture = create(detail({ status: 'ACTIVE' }), [member()], {
      onThisRequest: [timer({ startedAt })],
      others: [],
    });
    const c = comp(fixture);

    c.backToQueue();
    c.confirmDuration();

    const stop = httpMock.expectOne('/api/requests/5/timer/stop');
    expect(stop.request.method).toBe('POST');
    expect(stop.request.body).toEqual({});
    stop.flush({
      id: 1,
      requestId: 5,
      memberId: SUPPORT_ID,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMinutes: 30,
    });

    // Reloads the detail + side-loads.
    httpMock.expectOne('/api/requests/5').flush(detail({ status: 'ACTIVE' }));
    flushSideLoads(TEAM_ID);
    fixture.detectChanges();
    expect(c.durationPrompt()).toBeNull();
    expect(c.hasOpenTimer()).toBe(false);
    httpMock.verify();
  });

  it('confirming an EDITED duration sends the edited durationMinutes (R8.5, R8.6)', () => {
    const startedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const fixture = create(detail({ status: 'ACTIVE' }), [member()], {
      onThisRequest: [timer({ startedAt })],
      others: [],
    });
    const c = comp(fixture);

    c.backToQueue();
    c.onDurationInput('45');
    c.confirmDuration();

    const stop = httpMock.expectOne('/api/requests/5/timer/stop');
    expect(stop.request.body).toEqual({ durationMinutes: 45 });
    stop.flush({
      id: 1,
      requestId: 5,
      memberId: SUPPORT_ID,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMinutes: 45,
    });
    httpMock.expectOne('/api/requests/5').flush(detail({ status: 'ACTIVE' }));
    flushSideLoads(TEAM_ID);
    httpMock.verify();
  });

  it('client-validates an edited duration of ≤ 1 minute (> 1 minute rule, R8.5)', () => {
    const startedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const fixture = create(detail({ status: 'ACTIVE' }), [member()], {
      onThisRequest: [timer({ startedAt })],
      others: [],
    });
    const c = comp(fixture);

    c.backToQueue();
    c.onDurationInput('1'); // Edited to 1 minute → not allowed.
    c.confirmDuration();
    fixture.detectChanges();

    // No stop call was made; the pop-up shows a validation error.
    httpMock.verify();
    expect(c.durationPrompt()?.error).toContain('greater than 1 minute');
  });

  it('surfaces a server TIMER_MIN_DURATION in the duration pop-up (R8.5)', () => {
    const startedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const fixture = create(detail({ status: 'ACTIVE' }), [member()], {
      onThisRequest: [timer({ startedAt })],
      others: [],
    });
    const c = comp(fixture);

    c.backToQueue();
    c.onDurationInput('45');
    c.confirmDuration();

    const stop = httpMock.expectOne('/api/requests/5/timer/stop');
    stop.flush(
      { error: { code: 'TIMER_MIN_DURATION', message: 'The recorded time must be greater than one minute.' } },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    fixture.detectChanges();

    // The pop-up stays open and shows the server message.
    expect(c.durationPrompt()).not.toBeNull();
    expect(c.durationPrompt()?.error).toContain('greater than one minute');
    httpMock.verify();
  });

  it('handles INVALID_TRANSITION on start (request left ACTIVE) by reloading (R8.1)', () => {
    const fixture = create(detail({ status: 'ACTIVE' }));
    const c = comp(fixture);

    c.workOnIt();
    const start = httpMock.expectOne('/api/requests/5/timer/start');
    start.flush(
      { error: { code: 'INVALID_TRANSITION', message: 'A timer can only be started while a request is ACTIVE' } },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();

    // Reloads so the button reflects the real state.
    httpMock.expectOne('/api/requests/5').flush(detail({ status: 'PAUSED' }));
    flushSideLoads(TEAM_ID);
    fixture.detectChanges();
    expect(c.timerError()).toContain('no longer Active');
    httpMock.verify();
  });
});
