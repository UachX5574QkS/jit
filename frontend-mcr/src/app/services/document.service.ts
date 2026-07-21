import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

const API_BASE = '/ords/jit_schema/mcr/v1';

@Injectable({ providedIn: 'root' })
export class DocumentService {
  private readonly http = inject(HttpClient);

  getMCRDocuments(mcrId: number): Observable<any> {
    return this.http.get<any>(`${API_BASE}/documents/${mcrId}`);
  }

  uploadDocument(mcrId: number, data: any): Observable<any> {
    return this.http.post<any>(`${API_BASE}/documents/${mcrId}`, data);
  }

  getTaskDocuments(taskId: number): Observable<any> {
    return this.http.get<any>(`${API_BASE}/documents/${taskId}/links`);
  }

  updateTaskLinks(taskId: number, documentIds: number[]): Observable<any> {
    return this.http.put<any>(`${API_BASE}/documents/${taskId}/links`, { documentIds });
  }
}
