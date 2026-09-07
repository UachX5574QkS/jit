import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { API_CONFIG } from '../../core/http/api-config';
import { toDataType, type FieldDefinition } from '../../shared/fields/field-types';

/**
 * Typed client for the user-side request DETAIL contract (design: "Requests
 * (user side)"; R5). Feature code talks to this service, never to `HttpClient`
 * directly, so the REST contract is the only coupling to the backend (design:
 * "Data access"). Each method maps one documented endpoint:
 *
 *   • {@link getDetail}       GET   /api/requests/:id                (R5.1, R5.2, R17.4)
 *   • {@link updateUserFields} PATCH /api/requests/:id/user-fields   (R5.3, R5.4)
 *   • {@link addNote}          POST  /api/requests/:id/notes          (R5.3)
 *   • {@link cancel}           POST  /api/requests/:id/cancel         (R5.5)
 *   • {@link reopen}           POST  /api/requests/:id/reopen         (R5.6)
 *   • {@link clone}            POST  /api/requests/:id/clone          (R5.8)
 *
 * The backend already excludes support internal notes and internal-note audit
 * entries for a non-support viewer (R5.1, R17.4) and records `last_seen` on the
 * GET (which clears the viewer's "Updated" indicator, R5.2), so the screen
 * renders purely from typed data.
 */

// ── GET /api/requests/:id — detail view ─────────────────────────────────────

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

/** A note attached to the request (external notes only for a non-support viewer). */
export interface RequestNote {
  readonly id: number;
  readonly authorId: number;
  readonly isInternal: boolean;
  readonly body: string;
  readonly createdAt: string;
}

/** One column-level audit entry (internal-note entries excluded for non-support). */
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

/** The full request detail returned by `GET /api/requests/:id` (R5.1). */
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

// ── PATCH /api/requests/:id/user-fields ─────────────────────────────────────

/** One field value the raiser is updating (keyed by `task_field.id`, R5.4). */
export interface UserFieldUpdate {
  readonly taskFieldId: number;
  /** The new raw value; null clears an OPTIONAL field (R5.4). */
  readonly value: string | null;
}

/** The PATCH body for a user-fields update (R5.4). */
export interface UpdateUserFieldsBody {
  /** New Jira number; null clears it; omit to leave unchanged. */
  readonly jiraNumber?: string | null;
  /** Changed field values; omit/empty when only the Jira number changed. */
  readonly fieldValues?: readonly UserFieldUpdate[];
}

/** The request summary returned by the mutation endpoints (R5.4–5.6). */
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

/** The created note returned by `POST /api/requests/:id/notes` (R5.3). */
export interface CreatedNote {
  readonly id: number;
  readonly requestId: number;
  readonly authorId: number;
  readonly isInternal: boolean;
  readonly body: string;
  readonly createdAt: string;
}

// ── POST /api/requests/:id/clone — pre-populated New-workflow draft ──────────

/** One cloned field: the pinned-version field merged with the source value (R5.8). */
export interface CloneField {
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

/**
 * The pre-populated draft for the New workflow Step 2 (`POST .../clone`, R5.8).
 * Nothing is persisted; the real create happens via `POST /api/requests` after
 * the user reviews the pre-filled values.
 */
export interface CloneDraft {
  readonly taskId: number;
  readonly taskName: string;
  readonly teamId: number;
  readonly sourceTaskVersionId: number;
  readonly sourceVersionNo: number;
  readonly title: string;
  readonly jiraNumber: string | null;
  readonly status: 'NEW';
  readonly fields: readonly CloneField[];
}

/** Map a detail/clone field DTO into the shared {@link FieldDefinition}. */
export function toFieldDefinition(f: RequestFieldDetail | CloneField): FieldDefinition {
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
export class RequestDetailService {
  private readonly http = inject(HttpClient);
  private readonly apiConfig = inject(API_CONFIG);

  private get base(): string {
    return this.apiConfig.baseUrl;
  }

  /**
   * Fetch a request's full detail (`GET /api/requests/:id`, R5.1). The backend
   * excludes internal notes / internal-note audit entries for a non-support
   * viewer and records the viewer's `last_seen` (clearing the "Updated"
   * indicator, R5.2), so the caller renders exactly what it receives.
   */
  getDetail(id: number): Observable<RequestDetail> {
    return this.http.get<RequestDetail>(`${this.base}/requests/${id}`);
  }

  /**
   * Update the raiser's Jira number and/or user-entered field values
   * (`PATCH /api/requests/:id/user-fields`, R5.4). The server re-validates each
   * value against the pinned version and rejects blanking a mandatory field.
   */
  updateUserFields(id: number, body: UpdateUserFieldsBody): Observable<RequestSummary> {
    return this.http.patch<RequestSummary>(`${this.base}/requests/${id}/user-fields`, body);
  }

  /** Add an external note visible to support members (`POST .../notes`, R5.3). */
  addNote(id: number, body: string): Observable<CreatedNote> {
    return this.http.post<CreatedNote>(`${this.base}/requests/${id}/notes`, {
      body,
      isInternal: false,
    });
  }

  /** Cancel a non-stop request as its raiser (`POST .../cancel`, R5.5). */
  cancel(id: number): Observable<RequestSummary> {
    return this.http.post<RequestSummary>(`${this.base}/requests/${id}/cancel`, {});
  }

  /** Reopen a request the raiser cancelled (`POST .../reopen`, CANCELLED→NEW, R5.6). */
  reopen(id: number): Observable<RequestSummary> {
    return this.http.post<RequestSummary>(`${this.base}/requests/${id}/reopen`, {});
  }

  /** Fetch a pre-populated New-workflow draft (`POST .../clone`, R5.8). */
  clone(id: number): Observable<CloneDraft> {
    return this.http.post<CloneDraft>(`${this.base}/requests/${id}/clone`, {});
  }
}
