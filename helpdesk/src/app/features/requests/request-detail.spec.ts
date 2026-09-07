import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { CurrentUserService } from '../../core/auth/current-user.service';
import type { CurrentUser } from '../../core/auth/current-user.model';
import { CLONE_DRAFT_STATE_KEY } from '../new/new-workflow';
import { RequestDetail } from './request-detail';
import type {
  AuditEntry,
  CloneDraft,
  RequestDetail as RequestDetailModel,
  RequestFieldDetail,
  RequestNote,
} from './request-detail.service';

/**
 * Component tests for the user-side Requests DETAIL view (task 11.2; R5). They
 * exercise the behaviours the task calls out:
 *   • the audit trail renders WITHOUT internal-note content (R5.1);
 *   • the user-field edit form + mandatory gating (R5.4);
 *   • adding an external note (R5.3);
 *   • Cancel / Reopen visibility and their actions (R5.5, R5.6);
 *   • Clone navigating into the pre-populated New workflow (R5.8).
 */

const RAISER_ID = 100;
const OTHER_ID = 200;

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
    authorId: OTHER_ID,
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
    entityId: 1,
    fieldName: 'status',
    oldValue: 'NEW',
    newValue: 'TRIAGE',
    changedById: OTHER_ID,
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
    teamId: 1,
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

function makeUser(id: number): CurrentUser {
  return {
    id,
    username: '10000000',
    displayName: 'Test User',
    roles: new Set(['USER']),
    teamsLed: [],
    teamsMemberOf: [],
    isAdmin: false,
    timezone: null,
  };
}

type Comp = RequestDetail & {
  detail(): RequestDetailModel | null;
  editing(): boolean;
  formValid(): boolean;
  noteBody(): string;
  externalNotes(): readonly RequestNote[];
  auditTrail(): readonly AuditEntry[];
  isRaiser(): boolean;
  canCancel(): boolean;
  canReopen(): boolean;
  canSave(): boolean;
  canAddNote(): boolean;
  startEdit(): void;
  onNoteInput(v: string): void;
  addNote(): void;
  cancel(): void;
  reopen(): void;
  clone(): void;
  form(): { get(name: string): { setValue(v: unknown): void } | null } | null;
};

describe('RequestDetail (task 11.2; R5)', () => {
  let httpMock: HttpTestingController;
  let router: Router;

  /** The current-user snapshot the component reads; set per test before create. */
  let currentUserId = RAISER_ID;

  beforeEach(async () => {
    currentUserId = RAISER_ID;
    await TestBed.configureTestingModule({
      imports: [RequestDetail],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ id: '5' })) },
        },
        {
          provide: CurrentUserService,
          useValue: {
            // `snapshot()` is what the component reads; `user()` is a signal the
            // TimezoneService (via the local-date pipe) reads. Provide both.
            snapshot: () => makeUser(currentUserId),
            user: signal(makeUser(currentUserId)),
          },
        },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
  });

  /** Create the component and flush the initial detail load (R5.1). */
  function create(model: RequestDetailModel = detail()) {
    const fixture = TestBed.createComponent(RequestDetail);
    fixture.detectChanges();
    const req = httpMock.expectOne('/api/requests/5');
    expect(req.request.method).toBe('GET');
    req.flush(model);
    fixture.detectChanges();
    return fixture;
  }

  function comp(fixture: ReturnType<typeof create>): Comp {
    return fixture.componentInstance as unknown as Comp;
  }

  it('loads the request detail on init (R5.1, R5.2)', () => {
    const fixture = create();
    const c = comp(fixture);
    expect(c.detail()?.taskReference).toBe('REQ-5');
    httpMock.verify();
  });

  it('renders only external notes and never internal-note content (R5.1)', () => {
    // The backend excludes internal notes; even if one leaked through, the view
    // filters them so nothing internal is ever shown to a non-support viewer.
    const fixture = create(
      detail({
        notes: [
          note({ id: 1, body: 'Visible external note', isInternal: false }),
          note({ id: 2, body: 'SECRET internal note', isInternal: true }),
        ],
      }),
    );
    const c = comp(fixture);
    expect(c.externalNotes().map((n) => n.id)).toEqual([1]);

    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('Visible external note');
    expect(html).not.toContain('SECRET internal note');
    httpMock.verify();
  });

  it('renders the audit trail entries received (internal already excluded, R5.1/R17.4)', () => {
    const fixture = create(
      detail({ auditTrail: [audit({ id: 1, fieldName: 'title', oldValue: 'A', newValue: 'B' })] }),
    );
    const el = fixture.nativeElement as HTMLElement;
    const items = el.querySelectorAll('.audit-item');
    expect(items.length).toBe(1);
    expect(el.querySelector('.audit-field')?.textContent?.trim()).toBe('title');
    httpMock.verify();
  });

  it('gates Save on mandatory-not-blankable in the edit form (R5.4)', () => {
    const fixture = create(detail({ fields: [field({ taskFieldId: 1, isMandatory: true })] }));
    const c = comp(fixture);

    c.startEdit();
    fixture.detectChanges();
    expect(c.editing()).toBe(true);
    // Seeded with the original value → valid → saveable.
    expect(c.canSave()).toBe(true);

    // Blank the mandatory field → invalid → Save disabled (R5.4).
    c.form()?.get('1')?.setValue('');
    fixture.detectChanges();
    expect(c.formValid()).toBe(false);
    expect(c.canSave()).toBe(false);
    httpMock.verify();
  });

  it('PATCHes user-fields on save and reloads (R5.4)', () => {
    const fixture = create(detail({ jiraNumber: null, fields: [field({ taskFieldId: 1 })] }));
    const c = comp(fixture);

    c.startEdit();
    c.form()?.get('1')?.setValue('Updated value');
    c.form()?.get('jira')?.setValue('JIRA-9');
    fixture.detectChanges();
    (c as unknown as { save(): void }).save();

    const patch = httpMock.expectOne('/api/requests/5/user-fields');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body.jiraNumber).toBe('JIRA-9');
    expect(patch.request.body.fieldValues).toContainEqual({
      taskFieldId: 1,
      value: 'Updated value',
    });
    patch.flush({});

    // Save reloads the detail (R5.4).
    const reload = httpMock.expectOne('/api/requests/5');
    reload.flush(detail());
    httpMock.verify();
  });

  it('adds an external note and reloads (R5.3)', () => {
    const fixture = create();
    const c = comp(fixture);

    expect(c.canAddNote()).toBe(false);
    c.onNoteInput('Please expedite');
    fixture.detectChanges();
    expect(c.canAddNote()).toBe(true);

    c.addNote();
    const post = httpMock.expectOne('/api/requests/5/notes');
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({ body: 'Please expedite', isInternal: false });
    post.flush({
      id: 2,
      requestId: 5,
      authorId: RAISER_ID,
      isInternal: false,
      body: 'Please expedite',
      createdAt: '2026-02-05T12:00:00.000Z',
    });

    const reload = httpMock.expectOne('/api/requests/5');
    reload.flush(detail());
    fixture.detectChanges();
    expect(c.noteBody()).toBe('');
    httpMock.verify();
  });

  it('shows Cancel to the raiser on a non-stop request and posts cancel (R5.5)', () => {
    const fixture = create(detail({ status: 'NEW' }));
    const c = comp(fixture);
    expect(c.isRaiser()).toBe(true);
    expect(c.canCancel()).toBe(true);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Cancel Request');

    c.cancel();
    const post = httpMock.expectOne('/api/requests/5/cancel');
    expect(post.request.method).toBe('POST');
    post.flush(detail({ status: 'CANCELLED' }));
    httpMock.expectOne('/api/requests/5').flush(detail({ status: 'CANCELLED' }));
    httpMock.verify();
  });

  it('hides Cancel on a closed request (R5.5)', () => {
    const fixture = create(detail({ status: 'COMPLETE' }));
    const c = comp(fixture);
    expect(c.canCancel()).toBe(false);
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Cancel Request');
    httpMock.verify();
  });

  it('hides Cancel from a non-raiser viewer (R5.5)', () => {
    currentUserId = OTHER_ID;
    const fixture = create(detail({ status: 'NEW', raisedById: RAISER_ID }));
    const c = comp(fixture);
    expect(c.isRaiser()).toBe(false);
    expect(c.canCancel()).toBe(false);
    httpMock.verify();
  });

  it('shows Reopen only to the user who cancelled a CANCELLED request (R5.6)', () => {
    // Cancelled by the current user → Reopen shown.
    const fixture = create(
      detail({
        status: 'CANCELLED',
        auditTrail: [
          audit({ id: 9, fieldName: 'status', newValue: 'CANCELLED', changedById: RAISER_ID }),
        ],
      }),
    );
    const c = comp(fixture);
    expect(c.canReopen()).toBe(true);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Reopen');

    c.reopen();
    const post = httpMock.expectOne('/api/requests/5/reopen');
    expect(post.request.method).toBe('POST');
    post.flush(detail({ status: 'NEW' }));
    httpMock.expectOne('/api/requests/5').flush(detail({ status: 'NEW' }));
    httpMock.verify();
  });

  it('hides Reopen when someone else cancelled the request (R5.6)', () => {
    const fixture = create(
      detail({
        status: 'CANCELLED',
        auditTrail: [
          audit({ id: 9, fieldName: 'status', newValue: 'CANCELLED', changedById: OTHER_ID }),
        ],
      }),
    );
    const c = comp(fixture);
    expect(c.canReopen()).toBe(false);
    httpMock.verify();
  });

  it('clones into the pre-populated New workflow via router state (R5.8)', () => {
    const fixture = create();
    const c = comp(fixture);

    c.clone();
    const post = httpMock.expectOne('/api/requests/5/clone');
    expect(post.request.method).toBe('POST');
    const draft: CloneDraft = {
      taskId: 3,
      taskName: 'Access Request',
      teamId: 1,
      sourceTaskVersionId: 10,
      sourceVersionNo: 1,
      title: 'Need access',
      jiraNumber: null,
      status: 'NEW',
      fields: [{ ...field(), value: 'Original value' }],
    };
    post.flush(draft);

    expect(router.navigate).toHaveBeenCalledWith(['/new'], {
      state: { [CLONE_DRAFT_STATE_KEY]: draft },
    });
    httpMock.verify();
  });
});
