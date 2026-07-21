import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

const API_BASE = '/ords/jit_schema/mcr/v1';

@Injectable({ providedIn: 'root' })
export class UserService {
  private readonly http = inject(HttpClient);

  getUsers(): Observable<any[]> {
    return this.http.get<any>(`${API_BASE}/users/`).pipe(
      map(res => res.items ?? res ?? [])
    );
  }

  getUser(userId: number): Observable<any> {
    return this.http.get<any>(`${API_BASE}/users/${userId}`);
  }

  getDepartments(): Observable<any[]> {
    return this.http.get<any>(`${API_BASE}/users/departments`).pipe(
      map(res => res.items ?? res ?? [])
    );
  }

  getTeams(): Observable<any[]> {
    return this.http.get<any>(`${API_BASE}/users/teams`).pipe(
      map(res => res.items ?? res ?? [])
    );
  }

  createTeam(data: any): Observable<any> {
    return this.http.post<any>(`${API_BASE}/users/teams/create`, data);
  }
}
