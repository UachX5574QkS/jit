import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { API_CONFIG } from '../../core/http/api-config';
import { toDataType, type FieldDefinition } from '../../shared/fields/field-types';
import type { Status } from './status-transitions';

/**
 * Typed client for the SUPPORT-side request DETAIL contract (design: "Support
 * side"; R7, R9). Feature code talks to this service, never to `HttpClient`
 * directly, so the REST contract is the only coupling to the backend (design:
 * "Data access"). Each method maps one documented endpoint:
 *
 *   • {@link getDetail}   GET   /api/requests/:id                     (R7.1, R17.4)
 *   • {@link update}      PATCH /api/requests/:id                     (R7.1, R7.2, R9)
 *   • {@link addNote}     POST  /api/requests/:id/notes               (R7.3–7.6)
 *   • {@link listTeamMembers} GET /api/support/teams/:id/members      (R7.2)
 *
 * ── Support viewer vs raiser viewer (R7.4, R17.4) ────────────────────────────
 * The SAME `GET /api/requests/:id` serves both audiences; the backend decides,
 * from the caller's team membership, whether internal notes and internal-note
 * audit entries are included. For a SUPPORT viewer of the request's team they
 * ARE included (R7.4, R17.4), so the Support detail screen renders both internal
 * and external notes and the full audit trail exactly as received.
 *
 * ── The support PATCH (R7.1, R7.2, R9) ───────────────────────────────────────
 * A single PATCH updates any field value, the Jira number, the estimated/actual
 * start dates, the status (validated by the state machine — an illegal move
 * comes back as `INVALID_TRANSITION`), and/or the assignment (any team member,
 * or unassign). Every property is optional; absent means "leave unchanged".
 */

// ── GET /api/requests/:id — detail view (support viewer) ─────────────────────

/** One pinned-version field of the request, merged with its stored value. */
export interface RequestFieldDetail {
  readonly taskFieldId: number;
  readonly dataPointId: number;
  readonly fieldOrder: number;
  readonly name: string;
  readonly dataType: string;
  readonly isMandatory: boolean;
  readonly description: string | null;
  readonly helpText: string | null;
  readonly options: string[] | null;
  readonly regexpPattern: string | null;
  readonly value: string | null;
}

/** A note attached to the request. For a support viewer, BOTH internal and external appear (R7.4). */
export interface RequestNote {
  readonly id: number;
  readonly authorId: number;
  readonly isInternal: boolean;
  readonly body: string;
  readonly createdAt: string;
}

/** One column-level audit entry (support viewers see internal-note entries too, R17.4). */
export interface AuditEntry {
  readonly id: number;
  readonly entityType: string;
  readonly entityId: number;
  readonly fieldName: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly changedById: number;
  readonly changedAt: string;
}

/** The full request detail returned by `GET /api/requests/:id` (R7.1). */
export interface RequestDetail {
  readonly id: number;
  readonly taskReference: string;
  readonly taskVersionId: number;
  readonly taskId: number;
  readonly taskName: string;
  readonly versionNo: number;
  readonly title: string;
  readonly raisedById: number;
  readonly teamId: number;
  readonly assignedMemberId: number | null;
  readonly status: string;
  readonly jiraNumber: string | null;
  readonly estimatedStartDate: string | null;
  readonly actualStartDate: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly fields: readonly RequestFieldDetail[];
  readonly notes: readonly RequestNote[];
  readonly auditTrail: readonly AuditEntry[];
}

// ── PATCH /api/requests/:id — support update (R7.1, R7.2, R9) ────────────────

/** One field value the support member is updating (keyed by `task_field.id`). */
export interface SupportFieldUpdate {
  readonly taskFieldId: number;
  /** The new raw value; null clears an OPTIONAL field. */
  readonly value: string | null;
}

/**
 * The PATCH body for a support update (R7.1, R7.2, R9). Every property is
 * optional and absent means "leave unchanged"; an explicit `null` clears a
 * nullable column (jira/dates) or unassigns (`assignedMemberId`).
 */
export interface UpdateRequestBody {
  readonly fieldValues?: readonly SupportFieldUpdate[];
  readonly jiraNumber?: string | null;
  readonly estimatedStartDate?: string | null;
  readonly actualStartDate?: string | null;
  readonly status?: Status;
  readonly assignedMemberId?: number | null;
}

/** The request summary returned by the mutation endpoint. */
export interface RequestSummary {
  readonly id: number;
  readonly taskReference: string;
  readonly taskVersionId: number;
  readonly title: string;
  readonly raisedById: number;
  readonly teamId: number;
  readonly assignedMemberId: number | null;
  readonly status: string;
  readonly jiraNumber: string | null;
  readonly estimatedStartDate: string | null;
  readonly actualStartDate: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── POST /api/requests/:id/notes — internal or external note (R7.3) ──────────

/** The created note returned by `POST /api/requests/:id/notes`. */
export interface CreatedNote {
  readonly id: number;
  readonly requestId: number;
  readonly authorId: number;
  readonly isInternal: boolean;
  readonly body: string;
  readonly createdAt: string;
}

// ── GET /api/support/teams/:id/members — assignment drop-down (R7.2) ─────────

/** One candidate for the assignment drop-down (R7.2). */
export interface TeamMember {
  readonly userId: number;
  readonly username: string;
  readonly displayName: string;
}

// ── Time tracking (R8) ────────────────────────────────────────────────────────

/**
 * A running (open) timer, as returned by the timer endpoints (R8.2, R8.8).
 * Mirrors the backend `OpenTimerJson` view.
 */
export interface OpenTimer {
  readonly id: number;
  readonly requestId: number;
  readonly memberId: number;
  readonly startedAt: string;
}

/**
 * The result of `POST /api/requests/:id/timer/start` (R8.2, R8.8). `timer` is
 * the member's open timer on THIS request (existing or newly created);
 * `otherOpenTimers` are the member's open timers on OTHER requests at the moment
 * of starting (non-empty means the concurrent-timer prompt applied, R8.8);
 * `stoppedOthers` reports whether those others were auto-stopped.
 */
export interface StartTimerResult {
  readonly timer: OpenTimer;
  readonly otherOpenTimers: readonly OpenTimer[];
  readonly stoppedOthers: boolean;
}

/** The body for `POST /api/requests/:id/timer/start` (R8.8). */
export interface StartTimerBody {
  /** Resolve the concurrent-timer prompt: stop the member's OTHER timers first. */
  readonly stopOthers?: boolean;
}

/** A recorded time slice returned by `POST /api/requests/:id/timer/stop` (R8.6). */
export interface RecordedSlice {
  readonly id: number;
  readonly requestId: number;
  readonly memberId: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMinutes: number;
}

/**
 * The body for `POST /api/requests/:id/timer/stop` (R8.5). An edited
 * `durationMinutes` MUST be > 1 minute; when omitted the server records the
 * elapsed duration.
 */
export interface StopTimerBody {
  readonly durationMinutes?: number;
}

/**
 * The member's open timers relative to a request, from
 * `GET /api/requests/:id/timers/mine` (R8.8). `onThisRequest` drives the button
 * state ("Working on It" vs "Back to Queue"); `others` drive the
 * concurrent-timer prompt.
 */
export interface MyTimers {
  readonly onThisRequest: readonly OpenTimer[];
  readonly others: readonly OpenTimer[];
}

/** Map a detail field DTO into the shared {@link FieldDefinition}. */
export function toFieldDefinition(f: RequestFieldDetail): FieldDefinition {
  return {
    id: f.taskFieldId,
    dataType: toDataType(f.dataType),
    label: f.name,
    isMandatory: f.isMandatory,
    helpText: f.helpText,
    description: f.description,
    regexpPattern: f.regexpPattern,
    options: f.options,
  };
}

@Injectable({ providedIn: 'root' })
export class SupportDetailService {
  private readonly http = inject(HttpClient);
  private readonly apiConfig = inject(API_CONFIG);

  private get base(): string {
    return this.apiConfig.baseUrl;
  }

  /**
   * Fetch a request's full detail (`GET /api/requests/:id`, R7.1). For a support
   * viewer the backend INCLUDES internal notes and internal-note audit entries
   * (R7.4, R17.4), so the caller renders exactly what it receives.
   */
  getDetail(id: number): Observable<RequestDetail> {
    return this.http.get<RequestDetail>(`${this.base}/requests/${id}`);
  }

  /**
   * Support update of any field + status (state-machine checked) + assignment
   * (`PATCH /api/requests/:id`, R7.1, R7.2, R9). An illegal status move surfaces
   * as an `INVALID_TRANSITION` ApiError via the error interceptor.
   */
  update(id: number, body: UpdateRequestBody): Observable<RequestSummary> {
    return this.http.patch<RequestSummary>(`${this.base}/requests/${id}`, body);
  }

  /**
   * Add a note (`POST /api/requests/:id/notes`, R7.3). Support may set
   * `isInternal`: an internal note is visible only to support and does NOT flag
   * the raiser's "Updated" indicator (R7.5); an external note bumps it (R7.6).
   */
  addNote(id: number, body: string, isInternal: boolean): Observable<CreatedNote> {
    return this.http.post<CreatedNote>(`${this.base}/requests/${id}/notes`, {
      body,
      isInternal,
    });
  }

  /** Fetch the members of a team for the assignment drop-down (`GET .../members`, R7.2). */
  listTeamMembers(teamId: number): Observable<TeamMember[]> {
    return this.http
      .get<{ members: TeamMember[] }>(`${this.base}/support/teams/${teamId}/members`)
      .pipe(map((res) => res.members ?? []));
  }

  // ── Time tracking (R8) ──────────────────────────────────────────────────────

  /**
   * Start a timer on a request (`POST /api/requests/:id/timer/start`, R8.1,
   * R8.2, R8.8). The server allows this ONLY when the request is ACTIVE
   * (otherwise `INVALID_TRANSITION`) and never changes the request's status. An
   * optional `stopOthers` resolves the concurrent-timer prompt (R8.8): when the
   * member has open timers on OTHER requests, `true` stops-and-records them
   * first, `false`/omitted leaves them running. The result reports the member's
   * open timer on this request plus any other open timers.
   */
  startTimer(id: number, body: StartTimerBody = {}): Observable<StartTimerResult> {
    return this.http.post<StartTimerResult>(`${this.base}/requests/${id}/timer/start`, body);
  }

  /**
   * Stop the member's open timer on a request and record a slice
   * (`POST /api/requests/:id/timer/stop`, R8.4–8.6). When `durationMinutes` is
   * supplied it is the EDITED duration and MUST be > 1 minute — a value of 1 or
   * below surfaces as `TIMER_MIN_DURATION` (R8.5). When omitted the server
   * records the elapsed duration.
   */
  stopTimer(id: number, body: StopTimerBody = {}): Observable<RecordedSlice> {
    return this.http.post<RecordedSlice>(`${this.base}/requests/${id}/timer/stop`, body);
  }

  /**
   * Fetch the member's open timers relative to this request
   * (`GET /api/requests/:id/timers/mine`, R8.8) — the open timer on this request
   * (for button state) and any open timers on other requests (for the
   * concurrent-timer prompt).
   */
  listMyTimers(id: number): Observable<MyTimers> {
    return this.http
      .get<MyTimers>(`${this.base}/requests/${id}/timers/mine`)
      .pipe(
        map((res) => ({
          onThisRequest: res.onThisRequest ?? [],
          others: res.others ?? [],
        })),
      );
  }
}
