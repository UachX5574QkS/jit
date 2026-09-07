import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { API_CONFIG } from '../../core/http/api-config';
import { toDataType, type FieldDefinition } from '../../shared/fields/field-types';

/**
 * Typed client for the New-workflow backend contract (design: "Workflow
 * support" + "Requests (user side)"; R2, R3).
 *
 * Feature code talks to this service, never to `HttpClient` directly, so the
 * REST contract is the only coupling to the backend (design: "Data access").
 * Each method maps one documented endpoint:
 *
 *   • {@link listOpenTeams}      GET  /api/teams?open=true               (R2.3)
 *   • {@link listActiveTasks}    GET  /api/teams/:id/tasks?active=true    (R2.3)
 *   • {@link getCurrentVersion}  GET  /api/tasks/:id/current-version      (R2.5–2.8, R3.5)
 *   • {@link reviewSummary}      POST /api/review/summary                 (R2.11–2.12)
 *   • {@link createRequest}      POST /api/requests                        (R2.14)
 *
 * The current-version fields are mapped into the shared {@link FieldDefinition}
 * shape the {@link FormFieldComponent} and {@link fieldValidator} consume, so
 * Step 2 renders and gates entirely from typed data.
 */

/** A non-closed team offered on Step 1 (`GET /api/teams?open=true`, R2.3). */
export interface OpenTeam {
  readonly id: number;
  readonly title: string;
  readonly description: string | null;
}

/** A non-retired task offered on Step 1 (`GET /api/teams/:id/tasks`, R2.3). */
export interface ActiveTask {
  readonly id: number;
  readonly teamId: number;
  readonly name: string;
}

/** One field of a task's current version as returned by the backend. */
interface CurrentVersionFieldDto {
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
}

/** A task's current version and its ordered fields (`current-version`). */
interface CurrentVersionDto {
  readonly taskId: number;
  readonly taskName: string;
  readonly teamId: number;
  readonly versionId: number;
  readonly versionNo: number;
  readonly supportNotes: string | null;
  readonly fields: CurrentVersionFieldDto[];
}

/**
 * The task version to render on Step 2: the pinned version id (submitted with
 * the request, R2.14) plus its ordered {@link FieldDefinition} list ready for
 * the shared form-field components (R2.5–2.8, R3).
 */
export interface CurrentVersion {
  readonly taskId: number;
  readonly taskName: string;
  readonly teamId: number;
  readonly versionId: number;
  readonly versionNo: number;
  readonly supportNotes: string | null;
  readonly fields: readonly FieldDefinition[];
}

/** One entered value posted to `/review/summary` and `/requests`. */
export interface EnteredValue {
  readonly taskFieldId: number;
  /** The field label, for the summary prompt and the fallback display (R2.12). */
  readonly name: string;
  /** The raw entered value as a string (empty for a skipped optional). */
  readonly value: string;
}

/** A value echoed back by the summary fallback (`available:false`, R2.12). */
export interface ReviewValue {
  readonly taskFieldId: number;
  readonly name: string | null;
  readonly value: string;
}

/** Successful Ollama summary (`available:true`, R2.11). */
export interface ReviewSummaryAvailable {
  readonly available: true;
  readonly taskVersionId: number;
  readonly summary: string;
}

/** Graceful fallback when Ollama is unavailable (`available:false`, R2.12). */
export interface ReviewSummaryFallback {
  readonly available: false;
  readonly taskVersionId: number;
  readonly values: readonly ReviewValue[];
}

export type ReviewSummary = ReviewSummaryAvailable | ReviewSummaryFallback;

/** The body posted to `POST /api/requests` on submit (R2.14). */
export interface CreateRequestBody {
  readonly taskId: number;
  readonly title: string;
  readonly jiraNumber: string | null;
  readonly fieldValues: readonly { readonly taskFieldId: number; readonly value: string }[];
}

/** The created request returned by `POST /api/requests` (R2.14). */
export interface CreatedRequest {
  readonly id: number;
  readonly taskReference: string;
  readonly taskVersionId: number;
  readonly title: string;
  readonly status: string;
}

/** Envelope shapes returned by the list endpoints. */
interface TeamsResponse {
  readonly teams: OpenTeam[];
}
interface TasksResponse {
  readonly tasks: ActiveTask[];
}

/** Map a backend current-version field into the shared {@link FieldDefinition}. */
function toFieldDefinition(dto: CurrentVersionFieldDto): FieldDefinition {
  return {
    id: dto.taskFieldId,
    dataType: toDataType(dto.dataType),
    label: dto.name,
    isMandatory: dto.isMandatory,
    helpText: dto.helpText,
    description: dto.description,
    regexpPattern: dto.regexpPattern,
    options: dto.options,
  };
}

@Injectable({ providedIn: 'root' })
export class WorkflowService {
  private readonly http = inject(HttpClient);
  private readonly apiConfig = inject(API_CONFIG);

  private get base(): string {
    return this.apiConfig.baseUrl;
  }

  /** Non-closed teams for Step 1 (`GET /api/teams?open=true`, R2.3). */
  listOpenTeams(): Observable<OpenTeam[]> {
    return this.http
      .get<TeamsResponse>(`${this.base}/teams`, { params: new HttpParams().set('open', 'true') })
      .pipe(map((res) => res.teams ?? []));
  }

  /** A team's non-retired tasks (`GET /api/teams/:id/tasks?active=true`, R2.3). */
  listActiveTasks(teamId: number): Observable<ActiveTask[]> {
    return this.http
      .get<TasksResponse>(`${this.base}/teams/${teamId}/tasks`, {
        params: new HttpParams().set('active', 'true'),
      })
      .pipe(map((res) => res.tasks ?? []));
  }

  /**
   * The task's current (latest) version with its fields mapped into the shared
   * {@link FieldDefinition} shape for Step 2 (`GET /api/tasks/:id/current-version`,
   * R2.5–2.8, R3.5, R16.5).
   */
  getCurrentVersion(taskId: number): Observable<CurrentVersion> {
    return this.http.get<CurrentVersionDto>(`${this.base}/tasks/${taskId}/current-version`).pipe(
      map((dto) => ({
        taskId: dto.taskId,
        taskName: dto.taskName,
        teamId: dto.teamId,
        versionId: dto.versionId,
        versionNo: dto.versionNo,
        supportNotes: dto.supportNotes,
        fields: [...dto.fields]
          .sort((a, b) => a.fieldOrder - b.fieldOrder)
          .map(toFieldDefinition),
      })),
    );
  }

  /**
   * The Step 3 review summary (`POST /api/review/summary`, R2.11–2.12). The
   * backend already returns `{available:false}` (HTTP 200) on any Ollama
   * failure, so the caller only handles the two response shapes.
   */
  reviewSummary(
    taskVersionId: number,
    values: readonly EnteredValue[],
  ): Observable<ReviewSummary> {
    return this.http.post<ReviewSummary>(`${this.base}/review/summary`, {
      taskVersionId,
      values,
    });
  }

  /** Submit the request (`POST /api/requests`, R2.14). */
  createRequest(body: CreateRequestBody): Observable<CreatedRequest> {
    return this.http.post<CreatedRequest>(`${this.base}/requests`, body);
  }
}
