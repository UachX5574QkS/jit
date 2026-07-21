import { Component, Input, OnInit, inject } from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { TaskService } from '../../services/task.service';
import { ActionDialogComponent } from '../action-dialog/action-dialog.component';

@Component({
  selector: 'app-action-manager',
  standalone: true,
  imports: [
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatDialogModule
  ],
  template: `
    <div class="action-manager">
      <div class="action-header">
        <h3>Actions</h3>
        <button mat-stroked-button color="primary" (click)="openNewActionDialog()">
          <mat-icon>add</mat-icon> New
        </button>
      </div>

      @if (actions.length === 0) {
        <p class="no-actions">No actions defined.</p>
      }

      <mat-list>
        @for (action of actions; track action.action_id) {
          <mat-list-item>
            <span matListItemTitle>{{ action.ordinal_position }}. {{ action.title }}</span>
            <span matListItemLine>{{ action.description }}</span>
            <button matListItemMeta mat-icon-button color="warn" (click)="deleteAction(action.action_id)"
                    aria-label="Delete action">
              <mat-icon>delete</mat-icon>
            </button>
          </mat-list-item>
        }
      </mat-list>
    </div>
  `,
  styles: [`
    .action-manager {
      padding: 8px 0;
    }
    .action-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .action-header h3 {
      margin: 0;
      font-size: 16px;
      font-weight: 500;
    }
    .no-actions {
      color: rgba(0, 0, 0, 0.54);
      font-size: 14px;
      padding: 8px 0;
    }
  `]
})
export class ActionManagerComponent implements OnInit {
  @Input() taskId!: number;

  private readonly taskService = inject(TaskService);
  private readonly dialog = inject(MatDialog);
  private readonly dialogData: any = inject(MAT_DIALOG_DATA, { optional: true });

  actions: any[] = [];

  ngOnInit(): void {
    // Support being opened as a dialog with data.taskId
    if (this.dialogData?.taskId && !this.taskId) {
      this.taskId = this.dialogData.taskId;
    }
    this.loadActions();
  }

  loadActions(): void {
    if (this.taskId) {
      this.taskService.getActions(this.taskId).subscribe({
        next: (data) => this.actions = data ?? [],
        error: () => this.actions = []
      });
    }
  }

  openNewActionDialog(): void {
    const dialogRef = this.dialog.open(ActionDialogComponent, {
      width: '420px'
    });

    dialogRef.afterClosed().subscribe((result) => {
      if (result) {
        this.taskService.createAction(this.taskId, result).subscribe({
          next: () => this.loadActions()
        });
      }
    });
  }

  deleteAction(actionId: number): void {
    this.taskService.deleteAction(actionId).subscribe({
      next: () => this.loadActions()
    });
  }
}
