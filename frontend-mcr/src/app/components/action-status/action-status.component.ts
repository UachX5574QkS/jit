import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatDividerModule } from '@angular/material/divider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { TaskService } from '../../services/task.service';
import { AuthService } from '../../services/auth.service';

export interface ActionStatusDialogData {
  taskId: number;
  taskTitle: string;
  mcr: any;
}

@Component({
  selector: 'app-action-status',
  standalone: true,
  imports: [
    FormsModule,
    MatDialogModule,
    MatSelectModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatListModule,
    MatDividerModule,
    MatProgressSpinnerModule,
    MatSnackBarModule
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
        <div class="actions-list">
          @for (action of actions; track action.action_id) {
            <div class="action-row">
              <div class="action-info">
                <span class="action-ordinal">{{ action.ordinal_position }}.</span>
                <div class="action-details">
                  <span class="action-title">{{ action.title }}</span>
                  @if (action.description) {
                    <span class="action-desc">{{ action.description }}</span>
                  }
                </div>
              </div>
              <mat-form-field appearance="outline" class="status-field">
                <mat-select
                  [(value)]="action.action_status"
                  [disabled]="!canEditStatus()">
                  @for (status of actionStatuses; track status) {
                    <mat-option [value]="status">{{ formatStatus(status) }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
            </div>
          }
        </div>

        <mat-divider></mat-divider>

        <!-- Comments -->
        <mat-form-field appearance="outline" class="full-width comments-field">
          <mat-label>Comments</mat-label>
          <textarea matInput [(ngModel)]="comment" rows="3"
                    placeholder="Optional comment for this update"></textarea>
        </mat-form-field>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-flat-button color="primary"
              (click)="onSave()"
              [disabled]="saving || actions.length === 0 || !canEditStatus()">
        @if (saving) {
          <mat-spinner diameter="18" class="inline-spinner"></mat-spinner>
        } @else {
          Save
        }
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .loading-container {
      display: flex;
      justify-content: center;
      padding: 24px;
    }
    .empty-text {
      color: rgba(0, 0, 0, 0.54);
      font-size: 14px;
    }
    .actions-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 500px;
    }
    .action-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .action-info {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      flex: 1;
    }
    .action-ordinal {
      font-weight: 500;
      font-size: 14px;
      min-width: 24px;
    }
    .action-details {
      display: flex;
      flex-direction: column;
    }
    .action-title {
      font-size: 14px;
      font-weight: 500;
    }
    .action-desc {
      font-size: 12px;
      color: rgba(0, 0, 0, 0.6);
    }
    .status-field {
      width: 180px;
    }
    .full-width {
      width: 100%;
    }
    .comments-field {
      margin-top: 16px;
    }
    .inline-spinner {
      display: inline-block;
    }
    mat-divider {
      margin: 16px 0;
    }
  `]
})
export class ActionStatusComponent implements OnInit {
  readonly data: ActionStatusDialogData = inject(MAT_DIALOG_DATA);
  private readonly dialogRef = inject(MatDialogRef<ActionStatusComponent>);
  private readonly taskService = inject(TaskService);
  private readonly authService = inject(AuthService);
  private readonly snackBar = inject(MatSnackBar);

  actions: any[] = [];
  comment = '';
  loading = true;
  saving = false;

  readonly actionStatuses = [
    'Not_Started', 'Complete', 'Failed_Stop', 'Failed_Continue', 'Skipped'
  ];

  ngOnInit(): void {
    this.loadActions();
  }

  private loadActions(): void {
    this.loading = true;
    this.taskService.getActions(this.data.taskId).subscribe({
      next: (data) => {
        this.actions = (data ?? []).sort(
          (a: any, b: any) => a.ordinal_position - b.ordinal_position
        );
        this.loading = false;
      },
      error: () => {
        this.actions = [];
        this.loading = false;
      }
    });
  }

  /**
   * Status selectors are enabled only for Management Group or Owning Team users.
   */
  canEditStatus(): boolean {
    const userId = this.authService.getCurrentUserId();
    if (!userId) return false;

    // Check Management Group (Responsible or Accountable in RACI)
    const raci = this.data.mcr?.raci ?? [];
    const isManagement = raci.some((r: any) =>
      r.user_id === userId &&
      (r.raci_role === 'Responsible' || r.raci_role === 'Accountable')
    );
    if (isManagement) return true;

    // Owning Team check would compare user's department — simplified here
    return false;
  }

  formatStatus(status: string): string {
    return status.replace(/_/g, ' ');
  }

  onSave(): void {
    this.saving = true;

    const statuses = this.actions.map(a => ({
      action_id: a.action_id,
      action_status: a.action_status
    }));

    this.taskService.updateActionStatuses(
      this.data.taskId,
      statuses,
      this.comment.trim() || undefined
    ).subscribe({
      next: () => {
        this.saving = false;
        this.snackBar.open('Action statuses updated', 'Close', { duration: 3000 });
        this.dialogRef.close(true);
      },
      error: (err) => {
        this.saving = false;
        const msg = err.error?.message || 'Failed to update action statuses';
        this.snackBar.open(msg, 'Close', { duration: 5000 });
      }
    });
  }

  onCancel(): void {
    this.dialogRef.close(null);
  }
}
