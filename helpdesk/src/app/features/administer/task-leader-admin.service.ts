import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { API_CONFIG } from '../../core/http/api-config';
import type { DataType } from '../../shared/fields/field-types';

/**
 * Typed client for the Team-Leader task-management endpoints (design:
 * "Administration" — `POST/PATCH /api/team-leader/tasks` — create/new-version
 * tasks; retire; leader-of-THIS-team only; R16, R20.4), plus the reads used to
 * populate the picker and the edit form.
 *
 *   • {@link listOpenTeams}     GET   /api/teams?open=true               (team picker)
 *   • {@link listActiveTasks}   GET   /api/teams/:id/tasks?active=true    (R16.5)
 *   • {@link getCurrentVersion} GET   /api/tasks/:id/current-version      (R16.5, prefill edit)
 *   • {@link createTask}        POST  /api/team-leader/tasks              (R16.1, R16.2)
 *   • {@link createVersion}     PATCH /api/team-leader/tasks/:id          (R16.4 — new version)
 *   • {@link retireTask}        POST  /api/team-leader/tasks/:id/retire   (R16.6, R20.4)
 *
 * Feature code talks to this service, never to `HttpClient` directly, so the
 * REST contract is the only coupling to the backend (design: "Data access").
 *
 * ── Override restrictions (R16.3) ────────────────────────────────────────────
 * A field body may set order/mandatory and override the data point's
 * description/help text (and, for a DROPDOWN, its options) — but NEVER the data
 * point's name or data type. The service's {@link TaskFieldInput} deliberately
 * has no name/dataType, so those are structurally impossible to send; the
 * backend also rejects them with `VALIDATION_FAILED`.
 *
 * Errors are mapped to {@link ApiError} by the shared error interceptor, so the
 * screen branches on the code — `FORBIDDEN` if the caller does not lead the
 * team (R16.1) and `VALIDATION_FAILED` for a bad field (e.g. a retired data
 * point, R16.2).
 */

/** A non-closed team offered in the picker (`GET /api/teams?open=true`). */
export interface LeadableTeam {
  readonly id: number;
  readonly title: string;
}

/** A non-retired task in a team (`GET /api/teams/:id/tasks?active=true`, R16.5). */
export interface ActiveTask {
  readonly id: number;
  readonly teamId: number;
  readonly name: string;
}

/** A merged current-version field, ready to prefill the edit form (R16.5). */
export interface CurrentVersionField {
  readonly taskFieldId: number;
  readonly dataPointId: number;
  readonly fieldOrder: number;
  readonly name: string;
  readonly dataType: DataType;
  readonly isMandatory: boolean;
  readonly description: string | null;
  readonly helpText: string | null;
  readonly options: string[] | null;
  readonly regexpPattern: string | null;
}

/** A task's current (latest) version with its ordered fields (R16.5). */
export interface CurrentVersion {
  readonly taskId: number;
  readonly taskName: string;
  readonly teamId: number;
  readonly versionId: number;
  readonly versionNo: number;
  readonly supportNotes: string | null;
  readonly fields: CurrentVersionField[];
}

/**
 * A field as SENT to create/new-version (R16.2, R16.3). No name/dataType — those
 * come from the data point and are not overridable (R16.3).
 */
export interface TaskFieldInput {
  readonly dataPointId: number;
  readonly fieldOrder: number;
  readonly isMandatory: boolean;
  readonly descriptionOverride?: string | null;
  readonly helpTextOverride?: string | null;
  readonly optionsOverride?: string[] | null;
}

/** Body for creating a task with its first version (R16.1, R16.2). */
export interface CreateTaskRequest {
  readonly teamId: number;
  readonly name: string;
  readonly supportNotes?: string | null;
  readonly fields: TaskFieldInput[];
}

/** Body for editing a task — creates a NEW version (R16.4). */
export interface CreateVersionRequest {
  readonly name?: string;
  readonly supportNotes?: string | null;
  readonly fields: TaskFieldInput[];
}

/** A field on a task version as RETURNED by the team-leader task endpoints. */
export interface TaskFieldView {
  readonly id: number;
  readonly dataPointId: number;
  readonly fieldOrder: number;
  readonly isMandatory: boolean;
  readonly descriptionOverride: string | null;
  readonly helpTextOverride: string | null;
  readonly optionsOverride: string[] | null;
}

/** A task with its current version, as returned by create/new-version/retire. */
export interface TaskView {
  readonly id: number;
  readonly teamId: number;
  readonly name: string;
  readonly isRetired: boolean;
  readonly currentVersion: {
    readonly id: number;
    readonly versionNo: number;
    readonly supportNotes: string | null;
    readonly fields: TaskFieldView[];
  };
}

@Injectable({ providedIn: 'root' })
export class TaskLeaderAdminService {
  private readonly http = inject(HttpClient);
  private readonly apiConfig = inject(API_CONFIG);

  private get base(): string {
    return this.apiConfig.baseUrl;
  }

  /** Non-closed teams for the picker (`GET /api/teams?open=true`). */
  listOpenTeams(): Observable<LeadableTeam[]> {
    return this.http
      .get<{ teams: LeadableTeam[] }>(`${this.base}/teams`, {
        params: new HttpParams().set('open', 'true'),
      })
      .pipe(map((res) => res.teams.map((t) => ({ id: t.id, title: t.title }))));
  }

  /** A team's non-retired tasks (`GET /api/teams/:id/tasks?active=true`, R16.5). */
  listActiveTasks(teamId: number): Observable<ActiveTask[]> {
    return this.http
      .get<{ tasks: ActiveTask[] }>(`${this.base}/teams/${teamId}/tasks`, {
        params: new HttpParams().set('active', 'true'),
      })
      .pipe(map((res) => res.tasks));
  }

  /** A task's current version, used to prefill the edit form (R16.5). */
  getCurrentVersion(taskId: number): Observable<CurrentVersion> {
    return this.http.get<CurrentVersion>(`${this.base}/tasks/${taskId}/current-version`);
  }

  /** Create a task and its first version (R16.1, R16.2). */
  createTask(body: CreateTaskRequest): Observable<TaskView> {
    return this.http.post<TaskView>(`${this.base}/team-leader/tasks`, body);
  }

  /** Edit a task by creating a NEW version — version pinning (R16.4). */
  createVersion(taskId: number, body: CreateVersionRequest): Observable<TaskView> {
    return this.http.patch<TaskView>(`${this.base}/team-leader/tasks/${taskId}`, body);
  }

  /** Retire a task so it can't be chosen for new requests (R16.6, R20.4). */
  retireTask(taskId: number): Observable<TaskView> {
    return this.http.post<TaskView>(`${this.base}/team-leader/tasks/${taskId}/retire`, {});
  }
}
