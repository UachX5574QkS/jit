import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

const API_BASE = '/ords/jit_schema/mcr/v1';

@Injectable({ providedIn: 'root' })
export class MCRService {
  private readonly http = inject(HttpClient);

  getActiveMCRs(): Observable<any> {
    return this.http.get<any>(`${API_BASE}/requests/`);
  }

  getArchivedMCRs(): Observable<any> {
    return this.http.get<any>(`${API_BASE}/requests/archived`);
  }

  getMCR(id: number): Observable<any> {
    return this.http.get<any>(`${API_BASE}/requests/${id}`);
  }

  createMCR(data: any): Observable<any> {
    return this.http.post<any>(`${API_BASE}/requests/`, data);
  }

  updateMCR(id: number, data: any): Observable<any> {
    return this.http.put<any>(`${API_BASE}/requests/${id}`, data);
  }

  approveMCR(id: number): Observable<any> {
    return this.http.put<any>(`${API_BASE}/requests/${id}/approve`, {});
  }

  lockMCR(id: number): Observable<any> {
    return this.http.put<any>(`${API_BASE}/requests/${id}/lock`, {});
  }

  cancelMCR(id: number): Observable<any> {
    return this.http.put<any>(`${API_BASE}/requests/${id}/cancel`, {});
  }

  getPartialChanges(id: number): Observable<any> {
    return this.http.get<any>(`${API_BASE}/requests/${id}/partial-changes`);
  }

  getReport(id: number): Observable<any> {
    return this.http.get<any>(`${API_BASE}/requests/${id}/report`);
  }

  sendReport(id: number): Observable<any> {
    return this.http.post<any>(`${API_BASE}/requests/${id}/send-report`, {});
  }
}
