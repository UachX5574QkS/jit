import { Injectable, signal, computed } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly currentUserId = signal<number>(1);  // Default to Alex Morgan

  readonly isAuthenticated = computed(() => this.currentUserId() !== null);

  switchUser(userId: number): void {
    this.currentUserId.set(userId);
  }

  getCurrentUserId(): number {
    return this.currentUserId() ?? 1;
  }
}
