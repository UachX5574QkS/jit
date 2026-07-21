import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { MatTableModule } from '@angular/material/table';
import { MatSortModule, Sort } from '@angular/material/sort';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatRadioModule } from '@angular/material/radio';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../../services/auth.service';

@Component({
  selector: 'app-task-detail',
  standalone: true,
  imports: [
    MatTableModule,
    MatSortModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatDialogModule,
    MatRadioModule,
    MatFormFieldModule,
    MatTooltipModule,
    MatSnackBarModule,
    FormsModule
  ],
  template: `
    <div class="view-container">
      <div class="header-row">
        <button mat-icon-button (click)="goBack()">
          <mat-icon>arrow_back</mat-icon>
        </button>
        <h2>Tasks — {{ mcrNumber }}</h2>
        <span class="spacer"></span>
        <button mat-raised-button color="primary" (click)="addTask()">
          <mat-icon>add</mat-icon> Add Task
        </button>
      </div>

      @if (loading) {
        <div class="loading-container">
          <mat-spinner diameter="40"></mat-spinner>
        </div>
      } @else if (tasks.length === 0) {
        <p class="empty-text">No tasks found for this MCR. Click "Add Task" to create one.</p>
      } @else {
        <mat-card>
          <mat-card-content class="table-container">
            <table mat-table [dataSource]="sortedTasks" matSort (matSortChange)="onSort($event)" class="task-table">

              <ng-container matColumnDef="task_seq">
                <th mat-header-cell *matHeaderCellDef mat-sort-header>ID</th>
                <td mat-cell *matCellDef="let task">{{ task.task_seq }}</td>
              </ng-container>

              <ng-container matColumnDef="dependencies">
                <th mat-header-cell *matHeaderCellDef mat-sort-header>Deps</th>
                <td mat-cell *matCellDef="let task">{{ formatDeps(task) }}</td>
              </ng-container>

              <ng-container matColumnDef="title">
                <th mat-header-cell *matHeaderCellDef mat-sort-header>Title</th>
                <td mat-cell *matCellDef="let task" (click)="$event.stopPropagation()">
                  <div class="title-cell">
                    <span class="task-title clickable" (click)="toggleExpand(task)">{{ task.title }}</span>
                    @if (isExpanded(task) && task.description) {
                      <div class="task-description">{{ task.description }}</div>
                    }
                  </div>
                </td>
              </ng-container>

              <ng-container matColumnDef="owner_dept_id">
                <th mat-header-cell *matHeaderCellDef mat-sort-header>Owning Team</th>
                <td mat-cell *matCellDef="let task">{{ getDeptName(task.owner_dept_id) }}</td>
              </ng-container>

              <ng-container matColumnDef="created_by_user_id">
                <th mat-header-cell *matHeaderCellDef>Specified By</th>
                <td mat-cell *matCellDef="let task">{{ getUserName(task.created_by_user_id) }}</td>
              </ng-container>

              <ng-container matColumnDef="implementor">
                <th mat-header-cell *matHeaderCellDef>Actioned By</th>
                <td mat-cell *matCellDef="let task">{{ getImplementorName(task) }}</td>
              </ng-container>

              <ng-container matColumnDef="task_status_text">
                <th mat-header-cell *matHeaderCellDef mat-sort-header>Status</th>
                <td mat-cell *matCellDef="let task">
                  <span class="status-badge" [class]="'status-' + task.task_status.toLowerCase()">{{ task.task_status }}</span>
                </td>
              </ng-container>

              <ng-container matColumnDef="approval_action">
                <th mat-header-cell *matHeaderCellDef>Approval Action</th>
                <td mat-cell *matCellDef="let task" (click)="$event.stopPropagation()">
                  @if (isTerminalStatus(task.task_status)) {
                    <div class="status-with-undo">
                      <button mat-icon-button class="undo-btn" (click)="undoStatus(task); $event.stopPropagation()"
                              matTooltip="Undo status change">
                        <mat-icon>undo</mat-icon>
                      </button>
                    </div>
                  } @else if (task.task_status === 'Blocked_Dep') {
                    <span class="status-badge status-blocked">Blocked</span>
                  } @else if (getStatusOptions(task).length > 0) {
                    <mat-radio-group [value]="''"
                                     (change)="onStatusChange(task, $event.value)"
                                     class="status-radio-group">
                      @for (opt of getStatusOptions(task); track opt) {
                        <mat-radio-button [value]="opt" class="status-radio">
                          {{ opt }}
                        </mat-radio-button>
                      }
                    </mat-radio-group>
                  }
                </td>
              </ng-container>

              <ng-container matColumnDef="status_changed_by">
                <th mat-header-cell *matHeaderCellDef>Status Changed By</th>
                <td mat-cell *matCellDef="let task">{{ getUserName(task.status_changed_by_user_id) }}</td>
              </ng-container>

              <ng-container matColumnDef="soe">
                <th mat-header-cell *matHeaderCellDef>SOE</th>
                <td mat-cell *matCellDef="let task" (click)="$event.stopPropagation()">
                  @if (task.sub_actions) {
                    <mat-icon class="indicator-green clickable" (click)="showTextPopup('Steps', task.sub_actions)">check_circle</mat-icon>
                  } @else {
                    <mat-icon class="indicator-red">cancel</mat-icon>
                  }
                </td>
              </ng-container>

              <ng-container matColumnDef="backout">
                <th mat-header-cell *matHeaderCellDef>Backout</th>
                <td mat-cell *matCellDef="let task" (click)="$event.stopPropagation()">
                  @if (task.backout_plan) {
                    <mat-icon class="indicator-green clickable" (click)="showTextPopup('Backout Plan', task.backout_plan)">check_circle</mat-icon>
                  } @else {
                    <mat-icon class="indicator-red">cancel</mat-icon>
                  }
                </td>
              </ng-container>

              <ng-container matColumnDef="tcd">
                <th mat-header-cell *matHeaderCellDef>TCD</th>
                <td mat-cell *matCellDef="let task">
                  @if (task.has_tcd === 1 || task.has_tcd === true) {
                    <mat-icon class="indicator-green">check_circle</mat-icon>
                  } @else {
                    <mat-icon class="indicator-red">cancel</mat-icon>
                  }
                </td>
              </ng-container>

              <ng-container matColumnDef="est_start">
                <th mat-header-cell *matHeaderCellDef mat-sort-header>Est Start</th>
                <td mat-cell *matCellDef="let task">{{ formatStartDateTime(task) }}</td>
              </ng-container>

              <ng-container matColumnDef="jira_reference">
                <th mat-header-cell *matHeaderCellDef mat-sort-header>Jira Ref</th>
                <td mat-cell *matCellDef="let task">{{ task.jira_reference || '—' }}</td>
              </ng-container>

              <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
              <tr mat-row *matRowDef="let row; columns: displayedColumns;"
                  class="clickable-row" (click)="editTask(row)"></tr>
            </table>
          </mat-card-content>
        </mat-card>
      }
    </div>
  `,
  styles: [`
    .view-container { padding: 24px; }
    .header-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
    }
    .header-row h2 { margin: 0; font-size: 22px; font-weight: 500; }
    .spacer { flex: 1; }
    .loading-container { display: flex; justify-content: center; padding: 48px; }
    .empty-text { color: rgba(0, 0, 0, 0.54); font-size: 14px; }
    .table-container { overflow-x: auto; }
    .task-table { width: 100%; }
    .clickable-row { cursor: pointer; }
    .clickable-row:hover { background: var(--color-nw-purple-bg, #F3EFF8); }

    .status-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .status-complete { background: #e8f5e9; color: #2e7d32; }
    .status-cancelled { background: #f5f5f5; color: #616161; }
    .status-failed { background: #fce4ec; color: #c62828; }
    .status-blocked { background: #fff3e0; color: #e65100; }
    .status-blocked_dep { background: #fff3e0; color: #e65100; }
    .status-ready { background: #e3f2fd; color: #1565c0; }
    .status-approved { background: #e8f5e9; color: #2e7d32; }
    .status-draft { background: #f5f5f5; color: #9e9e9e; }
    .status-pending { background: #fff8e1; color: #f57f17; }
    .status-started { background: var(--color-nw-purple-bg, #F3EFF8); color: var(--color-nw-purple, #5A287D); }
    .status-rejected { background: #fce4ec; color: #c62828; }

    .status-with-undo {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .undo-btn {
      width: 24px;
      height: 24px;
      font-size: 16px;
    }
    .undo-btn mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
    }

    .status-radio-group {
      display: flex;
      flex-direction: row;
      gap: 8px;
    }
    .status-radio {
      font-size: 12px;
    }
    ::ng-deep .status-radio .mdc-radio { transform: scale(0.8); }
    ::ng-deep .status-radio .mdc-label { font-size: 12px; }

    .indicator-green {
      color: var(--color-green, #23A656);
      font-size: 18px;
      width: 18px;
      height: 18px;
    }
    .indicator-red {
      color: var(--color-red, #D5281B);
      font-size: 18px;
      width: 18px;
      height: 18px;
    }

    .title-cell {
      display: flex;
      flex-direction: column;
    }
    .task-title.clickable {
      cursor: pointer;
      color: var(--color-nw-purple, #5A287D);
      font-weight: 500;
    }
    .task-title.clickable:hover {
      text-decoration: underline;
    }
    .task-description {
      margin-top: 4px;
      font-size: 12px;
      color: var(--color-ink-2, #5B5B6E);
      padding: 4px 0;
    }
    .clickable { cursor: pointer; }
  `]
})
export class TaskDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly authService = inject(AuthService);

  mcrId!: number;
  mcrNumber = '';
  mcrStatus = '';
  tasks: any[] = [];
  sortedTasks: any[] = [];
  loading = true;
  departments: any[] = [];
  users: any[] = [];
  teams: any[] = [];

  readonly displayedColumns = ['task_seq', 'dependencies', 'jira_reference', 'title', 'owner_dept_id', 'created_by_user_id', 'implementor', 'est_start', 'task_status_text', 'approval_action', 'status_changed_by', 'soe', 'backout', 'tcd'];

  expandedTasks: Set<number> = new Set();

  ngOnInit(): void {
    this.mcrId = Number(this.route.snapshot.paramMap.get('id'));
    this.loadData();
    this.loadLookups();
  }

  async loadLookups(): Promise<void> {
    try {
      const [deptRes, userRes, teamRes] = await Promise.all([
        fetch('/ords/jit_schema/mcr/v1/users/departments'),
        fetch('/ords/jit_schema/mcr/v1/users/'),
        fetch('/ords/jit_schema/mcr/v1/users/teams')
      ]);
      if (deptRes.ok) { const d = await deptRes.json(); this.departments = d?.items ?? []; }
      if (userRes.ok) { const d = await userRes.json(); this.users = d?.items ?? []; }
      if (teamRes.ok) { const d = await teamRes.json(); this.teams = d?.items ?? []; }
      this.cdr.detectChanges();
    } catch {
      // Silent fail on lookups
    }
  }

  getDeptName(deptId: number | null): string {
    if (!deptId) return '—';
    const dept = this.departments.find(d => d.department_id === deptId);
    return dept?.department_name ?? `Dept #${deptId}`;
  }

  getUserName(userId: number | null): string {
    if (!userId) return '—';
    const user = this.users.find(u => u.user_id === userId);
    return user?.display_name ?? `User #${userId}`;
  }

  getTeamName(teamId: number | null): string {
    if (!teamId) return '—';
    const team = this.teams.find(t => t.team_id === teamId);
    return team?.team_name ?? `Team #${teamId}`;
  }

  getImplementorName(task: any): string {
    if (!task.implementor_id) return '—';
    if (task.implementor_type === 'DEPARTMENT') {
      return this.getDeptName(task.implementor_id);
    }
    if (task.implementor_type === 'TEAM') {
      return this.getTeamName(task.implementor_id);
    }
    // Default: USER
    return this.getUserName(task.implementor_id);
  }

  getStatusOptions(task: any): string[] {
    const status = task.task_status;
    if (['Complete', 'Failed', 'Blocked_Dep'].includes(status)) return [];

    // Pre-MCR-start states
    if (['Draft', 'Ready', 'Approved'].includes(this.mcrStatus)) {
      if (status === 'Draft') return []; // Need SOE + Backout first (auto-transitions to Pending)
      if (status === 'Pending') return ['Approve', 'Rejected', 'Cancel'];
      if (status === 'Approved' || status === 'Rejected' || status === 'Cancelled') return []; // Terminal pre-start (undo available)
      return [];
    }

    // MCR Active/Active_Late
    if (this.mcrStatus === 'Active' || this.mcrStatus === 'Active_Late') {
      if (status === 'Approved') return ['Started', 'Cancelled'];
      if (status === 'Started') {
        // Check deps for Complete
        const depsBlocked = this.areDepsBlocked(task);
        if (depsBlocked) return ['Cancelled', 'Failed'];
        return ['Complete', 'Cancelled', 'Failed'];
      }
      if (status === 'Cancelled' || status === 'Rejected') return [];
      return [];
    }
    return [];
  }

  areDepsBlocked(task: any): boolean {
    const hardDeps = (task.hard_dep_ids || '').split(',').filter(Boolean).map(Number);
    const allHardMet = hardDeps.every((depId: number) => {
      const dep = this.tasks.find(t => t.task_id === depId);
      return dep && dep.task_status === 'Complete';
    });
    const softDeps = (task.soft_dep_ids || '').split(',').filter(Boolean).map(Number);
    const allSoftMet = softDeps.every((depId: number) => {
      const dep = this.tasks.find(t => t.task_id === depId);
      return dep && ['Complete', 'Cancelled', 'Failed'].includes(dep.task_status);
    });
    return (!allHardMet && hardDeps.length > 0) || (!allSoftMet && softDeps.length > 0);
  }

  isTerminalStatus(status: string): boolean {
    return ['Complete', 'Cancelled', 'Failed', 'Approved', 'Rejected'].includes(status);
  }

  async loadData(): Promise<void> {
    this.loading = true;
    this.cdr.detectChanges();

    try {
      const mcrRes = await fetch(`/ords/jit_schema/mcr/v1/requests/${this.mcrId}`);
      if (mcrRes.ok) {
        const mcr = await mcrRes.json();
        this.mcrNumber = mcr?.mcr_number ?? `MCR #${this.mcrId}`;
        this.mcrStatus = mcr?.mcr_status ?? '';
      }
    } catch {
      this.mcrNumber = `MCR #${this.mcrId}`;
    }

    try {
      const taskRes = await fetch(`/ords/jit_schema/mcr/v1/tasks/mcr/${this.mcrId}`);
      if (taskRes.ok) {
        const data = await taskRes.json();
        this.tasks = data?.items ?? (Array.isArray(data) ? data : []);
      } else {
        this.tasks = [];
      }
    } catch {
      this.tasks = [];
    }

    this.sortedTasks = [...this.tasks];
    this.loading = false;
    this.cdr.detectChanges();
  }

  async onStatusChange(task: any, newStatus: string): Promise<void> {
    if (!newStatus) return;
    // Map UI action words to actual task statuses
    let actualStatus = newStatus;
    if (newStatus === 'Approve') actualStatus = 'Approved';
    if (newStatus === 'Rejected') actualStatus = 'Rejected';
    if (newStatus === 'Cancel') actualStatus = 'Cancelled';
    // Started, Complete, Failed, Cancelled stay as-is

    const userId = this.authService.getCurrentUserId();
    const payload = {
      user_id: userId,
      task_id: task.task_id,
      new_status: actualStatus
    };

    try {
      const res = await fetch('/ords/jit_schema/mcr/v1/tasks/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        task.previous_status = task.task_status;
        task.task_status = actualStatus;
        task.status_changed_by_user_id = userId;
        this.snackBar.open(`Status updated to ${actualStatus}`, 'OK', { duration: 3000 });
      } else {
        this.snackBar.open('Failed to update status', 'OK', { duration: 4000 });
      }
    } catch {
      this.snackBar.open('Network error updating status', 'OK', { duration: 4000 });
    }
    this.cdr.detectChanges();
  }

  async undoStatus(task: any): Promise<void> {
    // Revert to previous_status
    const revertTo = task.previous_status || 'Pending';
    const userId = this.authService.getCurrentUserId();
    const payload = { user_id: userId, task_id: task.task_id, new_status: revertTo };
    try {
      const res = await fetch('/ords/jit_schema/mcr/v1/tasks/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        task.previous_status = task.task_status;
        task.task_status = revertTo;
        task.status_changed_by_user_id = userId;
        this.snackBar.open(`Status reverted to ${revertTo}`, 'OK', { duration: 3000 });
      }
    } catch {}
    this.cdr.detectChanges();
  }

  onSort(sort: Sort): void {
    if (!sort.active || sort.direction === '') {
      this.sortedTasks = [...this.tasks];
      return;
    }
    this.sortedTasks = [...this.tasks].sort((a, b) => {
      const aVal = a[sort.active] ?? '';
      const bVal = b[sort.active] ?? '';
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sort.direction === 'asc' ? cmp : -cmp;
    });
    this.cdr.detectChanges();
  }

  editTask(task: any): void {
    import('./edit-task-dialog.component').then(m => {
      const dialogRef = this.dialog.open(m.EditTaskDialogComponent, {
        width: '650px',
        data: { mcrId: this.mcrId, task, readOnly: this.mcrStatus === 'Active', mcrStatus: this.mcrStatus, tasks: this.tasks }
      });
      dialogRef.afterClosed().subscribe(result => {
        if (result) {
          this.loadData();
        }
      });
    });
  }

  openActions(task: any): void {
    import('./task-actions-dialog.component').then(m => {
      this.dialog.open(m.TaskActionsDialogComponent, {
        width: '550px',
        data: { taskId: task.task_id, taskTitle: task.title }
      });
    });
  }

  toggleExpand(task: any): void {
    if (this.expandedTasks.has(task.task_id)) {
      this.expandedTasks.delete(task.task_id);
    } else {
      this.expandedTasks.add(task.task_id);
    }
    this.cdr.detectChanges();
  }

  isExpanded(task: any): boolean {
    return this.expandedTasks.has(task.task_id);
  }

  formatStartDateTime(task: any): string {
    if (!task.est_start_date) return '—';
    const parts = task.est_start_date.split('-');
    const formatted = `${parts[2]}/${parts[1]}/${parts[0]}`;
    if (task.est_start_time) return `${formatted} ${task.est_start_time}`;
    return formatted;
  }

  formatDeps(task: any): string {
    const allDeps = [task.hard_dep_ids, task.soft_dep_ids].filter(Boolean).join(',');
    if (!allDeps) return '—';
    const ids = allDeps.split(',').filter(Boolean).map(Number);
    const seqs = ids.map(id => {
      const t = this.tasks.find(t => t.task_id === id);
      return t ? t.task_seq : id;
    });
    return seqs.join(', ');
  }

  showTextPopup(title: string, content: string): void {
    import('./text-view-dialog.component').then(m => {
      this.dialog.open(m.TextViewDialogComponent, {
        width: '500px',
        data: { title, content }
      });
    });
  }

  goBack(): void {
    this.router.navigate(['/active']);
  }

  addTask(): void {
    import('./add-task-dialog.component').then(m => {
      const dialogRef = this.dialog.open(m.AddTaskDialogComponent, {
        width: '600px',
        data: { mcrId: this.mcrId }
      });
      dialogRef.afterClosed().subscribe(result => {
        if (result) {
          this.loadData();
        }
      });
    });
  }
}
