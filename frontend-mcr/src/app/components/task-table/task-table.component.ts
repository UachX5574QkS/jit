import { Component, Input, Output, EventEmitter } from '@angular/core';
import { MatTableModule } from '@angular/material/table';
import { MatSortModule } from '@angular/material/sort';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { inject } from '@angular/core';
import { ActionManagerComponent } from '../action-manager/action-manager.component';

@Component({
  selector: 'app-task-table',
  standalone: true,
  imports: [
    MatTableModule,
    MatSortModule,
    MatButtonModule,
    MatIconModule,
    MatDialogModule
  ],
  template: `
    <div class="task-table-container">
      <div class="table-header">
        <h3>Tasks</h3>
        <button mat-flat-button color="primary" (click)="addTask.emit()">
          <mat-icon>add</mat-icon> New
        </button>
      </div>

      <table mat-table [dataSource]="tasks" matSort class="full-width">
        <!-- ID Column -->
        <ng-container matColumnDef="task_seq">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>ID</th>
          <td mat-cell *matCellDef="let task">{{ task.task_seq }}</td>
        </ng-container>

        <!-- Hard Dependencies Column -->
        <ng-container matColumnDef="hard_dependencies">
          <th mat-header-cell *matHeaderCellDef>Hard Deps</th>
          <td mat-cell *matCellDef="let task">{{ formatDeps(task.hard_dependencies) }}</td>
        </ng-container>

        <!-- Soft Dependencies Column -->
        <ng-container matColumnDef="soft_dependencies">
          <th mat-header-cell *matHeaderCellDef>Soft Deps</th>
          <td mat-cell *matCellDef="let task">{{ formatDeps(task.soft_dependencies) }}</td>
        </ng-container>

        <!-- Jira Reference Column -->
        <ng-container matColumnDef="jira_reference">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Jira Ref</th>
          <td mat-cell *matCellDef="let task">{{ task.jira_reference }}</td>
        </ng-container>

        <!-- Start Time Column -->
        <ng-container matColumnDef="start_time">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Start Time</th>
          <td mat-cell *matCellDef="let task">{{ task.start_time }}</td>
        </ng-container>

        <!-- Estimated Duration Column -->
        <ng-container matColumnDef="estimated_duration_mins">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Duration (min)</th>
          <td mat-cell *matCellDef="let task">{{ task.estimated_duration_mins }}</td>
        </ng-container>

        <!-- Owner Column -->
        <ng-container matColumnDef="owner_dept_id">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Owner</th>
          <td mat-cell *matCellDef="let task">{{ task.owner_dept_name || task.owner_dept_id }}</td>
        </ng-container>

        <!-- Implementor Column -->
        <ng-container matColumnDef="implementor">
          <th mat-header-cell *matHeaderCellDef>Implementor</th>
          <td mat-cell *matCellDef="let task">{{ task.implementor_name || task.implementor_id }}</td>
        </ng-container>

        <!-- Title Column -->
        <ng-container matColumnDef="title">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Title</th>
          <td mat-cell *matCellDef="let task">{{ task.title }}</td>
        </ng-container>

        <!-- Benefits Column -->
        <ng-container matColumnDef="benefits">
          <th mat-header-cell *matHeaderCellDef>Benefits</th>
          <td mat-cell *matCellDef="let task">{{ task.benefits }}</td>
        </ng-container>

        <!-- Description Column -->
        <ng-container matColumnDef="description">
          <th mat-header-cell *matHeaderCellDef>Description</th>
          <td mat-cell *matCellDef="let task">{{ task.description }}</td>
        </ng-container>

        <!-- Actions Column -->
        <ng-container matColumnDef="actions">
          <th mat-header-cell *matHeaderCellDef>Actions</th>
          <td mat-cell *matCellDef="let task">
            <button mat-icon-button color="primary" (click)="openActions(task, $event)"
                    aria-label="View task actions">
              <mat-icon>checklist</mat-icon>
            </button>
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
        <tr mat-row *matRowDef="let row; columns: displayedColumns;"
            class="task-row"
            (click)="editTask.emit(row)"></tr>
      </table>

      @if (tasks.length === 0) {
        <p class="no-data">No tasks yet. Click "New" to add one.</p>
      }
    </div>
  `,
  styles: [`
    .task-table-container {
      padding: 16px 0;
    }
    .table-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .table-header h3 {
      margin: 0;
      font-size: 18px;
      font-weight: 500;
    }
    .full-width {
      width: 100%;
    }
    .task-row {
      cursor: pointer;
    }
    .task-row:hover {
      background-color: rgba(0, 0, 0, 0.04);
    }
    .no-data {
      text-align: center;
      color: rgba(0, 0, 0, 0.54);
      padding: 24px;
      font-size: 14px;
    }
  `]
})
export class TaskTableComponent {
  @Input({ required: true }) mcrId!: number;
  @Input() tasks: any[] = [];

  @Output() addTask = new EventEmitter<void>();
  @Output() editTask = new EventEmitter<any>();

  private readonly dialog = inject(MatDialog);

  readonly displayedColumns: string[] = [
    'task_seq',
    'hard_dependencies',
    'soft_dependencies',
    'jira_reference',
    'start_time',
    'estimated_duration_mins',
    'owner_dept_id',
    'implementor',
    'title',
    'benefits',
    'description',
    'actions'
  ];

  formatDeps(deps: any[] | undefined): string {
    if (!deps || deps.length === 0) return '—';
    return deps.map((d: any) => d.task_seq ?? d.depends_on_task_id).join(', ');
  }

  openActions(task: any, event: MouseEvent): void {
    event.stopPropagation();
    this.dialog.open(ActionManagerComponent, {
      width: '500px',
      data: { taskId: task.task_id }
    });
  }
}
