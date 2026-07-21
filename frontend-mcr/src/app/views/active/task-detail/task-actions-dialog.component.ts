import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatListModule } from '@angular/material/list';
import { MatChipsModule } from '@angular/material/chips';

export interface TaskActionsDialogData {
  taskId: number;
  taskTitle: string;
}

@Component({
  selector: 'app-task-actions-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatListModule,
    MatChipsModule
  ],
  template: `
    <h2 mat-dialog-title>Actions — {{ data.taskTitle }}</h2>
    <mat-dialog-content>
      @if (loading) {
        <div class="loading-container">
          <mat-spinner diameter="32"></mat-spinner>
        </div>
      } @else if (actions.length === 0) {
        <p class="empty-text">No actions defined for this task.</p>
      } @else {
        <mat-list>
          @for (action of actions; track action.action_id) {
            <mat-list-item>
              <mat-icon matListItemIcon>{{ getActionIcon(action.action_type) }}</mat-icon>
              <div matListItemTitle>{{ action.description || action.action_type }}</div>
              <div matListItemLine>
                <span class="action-chip" [class]="'action-' + (action.action_status || 'pending').toLowerCase()">
                  {{ action.action_status || 'Pending' }}
                </span>
                @if (action.target_name) {
                  <span class="action-target">→ {{ action.target_name }}</span>
                }
              </div>
            </mat-list-item>
          }
        </mat-list>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Close</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .loading-container {
      display: flex;
      justify-content: center;
      padding: 32px;
    }
    .empty-text {
      color: rgba(0, 0, 0, 0.54);
      font-size: 14px;
      padding: 16px;
    }
    .action-chip {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
    }
    .action-pending { background: #f5f5f5; color: #616161; }
    .action-complete, .action-completed { background: #e8f5e9; color: #2e7d32; }
    .action-in_progress { background: #e3f2fd; color: #1565c0; }
    .action-failed { background: #fce4ec; color: #c62828; }
    .action-target {
      margin-left: 8px;
      font-size: 12px;
      color: rgba(0, 0, 0, 0.54);
    }
  `]
})
export class TaskActionsDialogComponent implements OnInit {
  readonly data: TaskActionsDialogData = inject(MAT_DIALOG_DATA);
  private readonly dialogRef = inject(MatDialogRef<TaskActionsDialogComponent>);
  private readonly cdr = inject(ChangeDetectorRef);

  actions: any[] = [];
  loading = true;

  ngOnInit(): void {
    this.loadActions();
  }

  private async loadActions(): Promise<void> {
    this.loading = true;
    this.cdr.detectChanges();

    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/actions/${this.data.taskId}`);
      if (res.ok) {
        const data = await res.json();
        this.actions = data?.items ?? (Array.isArray(data) ? data : []);
      } else {
        this.actions = [];
      }
    } catch {
      this.actions = [];
    }

    this.loading = false;
    this.cdr.detectChanges();
  }

  getActionIcon(type: string): string {
    switch ((type || '').toUpperCase()) {
      case 'GRANT': return 'vpn_key';
      case 'REVOKE': return 'lock';
      case 'DEPLOY': return 'rocket_launch';
      case 'VERIFY': return 'check_circle';
      case 'NOTIFY': return 'notifications';
      default: return 'task_alt';
    }
  }
}
