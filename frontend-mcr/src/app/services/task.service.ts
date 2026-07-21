import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

const API_BASE = '/ords/jit_schema/mcr/v1';

@Injectable({ providedIn: 'root' })
export class TaskService {
  private readonly http = inject(HttpClient);

  // Task CRUD

  getTasks(mcrId: number): Observable<any[]> {
    return this.http.get<any[]>(`${API_BASE}/tasks/${mcrId}`);
  }

  createTask(mcrId: number, data: any): Observable<any> {
    return this.http.post<any>(`${API_BASE}/tasks/${mcrId}`, data);
  }

  updateTask(taskId: number, data: any): Observable<any> {
    return this.http.put<any>(`${API_BASE}/tasks/${taskId}`, data);
  }

  deleteTask(taskId: number): Observable<any> {
    return this.http.delete<any>(`${API_BASE}/tasks/${taskId}`);
  }

  changeTaskStatus(taskId: number, newStatus: string): Observable<any> {
    return this.http.put<any>(`${API_BASE}/tasks/${taskId}/status`, { status: newStatus });
  }

  getDependencyMap(mcrId: number): Observable<any> {
    return this.http.get<any>(`${API_BASE}/tasks/${mcrId}/dependency-map`);
  }

  // Action CRUD

  getActions(taskId: number): Observable<any[]> {
    return this.http.get<any[]>(`${API_BASE}/actions/${taskId}`);
  }

  createAction(taskId: number, data: any): Observable<any> {
    return this.http.post<any>(`${API_BASE}/actions/${taskId}`, data);
  }

  updateAction(actionId: number, data: any): Observable<any> {
    return this.http.put<any>(`${API_BASE}/actions/${actionId}`, data);
  }

  deleteAction(actionId: number): Observable<any> {
    return this.http.delete<any>(`${API_BASE}/actions/${actionId}`);
  }

  updateActionStatuses(taskId: number, statuses: any[], comment?: string): Observable<any> {
    return this.http.put<any>(`${API_BASE}/actions/${taskId}/statuses`, { statuses, comment });
  }
}
