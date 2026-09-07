import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { API_CONFIG } from '../../core/http/api-config';
import type { DataType } from '../../shared/fields/field-types';

/**
 * Typed client for the data point administration endpoints (design:
 * "Administration" — `POST/GET/PATCH /api/admin/data-points`; R14, R20.4).
 * Feature code talks to this service, never to `HttpClient` directly.
 *
 *   • {@link listDataPoints}  GET   /api/admin/data-points      (R14.1)
 *   • {@link createDataPoint} POST  /api/admin/data-points      (R14.2)
 *   • {@link retireDataPoint} PATCH /api/admin/data-points/:id  (R14.3, R14.4)
 *
 * Errors are mapped to {@link ApiError} by the shared error interceptor, so the
 * screen branches on the code — `VALIDATION_FAILED` for a bad create body (e.g.
 * a DROPDOWN with no options, R14.2) and `FORBIDDEN` if a non-admin reaches an
 * endpoint (R14/R13.1).
 */

/** The public JSON view of a data point (design: R14). */
export interface DataPointView {
  readonly id: number;
  readonly name: string;
  readonly dataType: DataType;
  readonly description: string | null;
  readonly defaultHelpText: string | null;
  readonly regexpPattern: string | null;
  readonly defaultOptions: string[] | null;
  readonly isRetired: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Body for creating a data point (R14.2). `regexpPattern` is required for a
 * REGEXP type and `defaultOptions` for a DROPDOWN; both are ignored (and stored
 * null) for other types by the backend.
 */
export interface CreateDataPointRequest {
  readonly name: string;
  readonly dataType: DataType;
  readonly description?: string | null;
  readonly defaultHelpText?: string | null;
  readonly regexpPattern?: string | null;
  readonly defaultOptions?: string[] | null;
}

@Injectable({ providedIn: 'root' })
export class DataPointAdminService {
  private readonly http = inject(HttpClient);
  private readonly apiConfig = inject(API_CONFIG);

  private get base(): string {
    return this.apiConfig.baseUrl;
  }

  /** List every data point (retired and active) for the admin table (R14.1). */
  listDataPoints(): Observable<DataPointView[]> {
    return this.http
      .get<{ dataPoints: DataPointView[] }>(`${this.base}/admin/data-points`)
      .pipe(map((res) => res.dataPoints));
  }

  /** Create a data point (R14.2). */
  createDataPoint(body: CreateDataPointRequest): Observable<DataPointView> {
    return this.http.post<DataPointView>(`${this.base}/admin/data-points`, body);
  }

  /**
   * Retire a data point (R14.3): it can no longer be picked for NEW task
   * definitions, but stays operational for task versions already using it
   * (R14.4). Returns the updated view.
   */
  retireDataPoint(id: number): Observable<DataPointView> {
    return this.http.patch<DataPointView>(`${this.base}/admin/data-points/${id}`, {});
  }
}
