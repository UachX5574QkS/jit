import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { AuthService } from '../../../services/auth.service';

@Component({
  selector: 'app-report',
  standalone: true,
  imports: [
    CommonModule,
    DatePipe,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatDividerModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatTableModule
  ],
  template: `
    @if (loading) {
      <div class="loading-container">
        <mat-spinner diameter="40"></mat-spinner>
      </div>
    } @else if (error) {
      <div class="error-container">
        <mat-icon color="warn">error</mat-icon>
        <p>{{ error }}</p>
        <button mat-button (click)="goBack()">Back</button>
      </div>
    } @else {
      <div class="report-container">
        <div class="report-header">
          <button mat-icon-button (click)="goBack()" aria-label="Go back">
            <mat-icon>arrow_back</mat-icon>
          </button>
          <h2>MCR Report</h2>
          <div class="spacer"></div>
          <button mat-flat-button color="primary" (click)="sendReport()" [disabled]="sending">
            <mat-icon>email</mat-icon>
            {{ sending ? 'Sending...' : 'Send Report' }}
          </button>
        </div>

        <!-- MCR Details -->
        <mat-card class="report-card">
          <mat-card-header>
            <mat-card-title>{{ mcr?.mcr_number || 'MCR' }} — {{ mcr?.description || 'Untitled' }}</mat-card-title>
            <mat-card-subtitle>Status: {{ mcr?.mcr_status }} | Owner: {{ mcr?.owner_name || '—' }}</mat-card-subtitle>
          </mat-card-header>
          <mat-card-content>
            <div class="detail-grid">
              <div class="detail-item">
                <span class="label">MCR Number</span>
                <span class="value">{{ mcr?.mcr_number }}</span>
              </div>
              <div class="detail-item">
                <span class="label">Owner</span>
                <span class="value">{{ mcr?.owner_name || '—' }}</span>
              </div>
              <div class="detail-item">
                <span class="label">Start Date</span>
                <span class="value">{{ mcr?.start_date | date:'mediumDate' }}</span>
              </div>
              <div class="detail-item">
                <span class="label">End Date</span>
                <span class="value">{{ mcr?.end_date | date:'mediumDate' }}</span>
              </div>
              <div class="detail-item">
                <span class="label">Status</span>
                <span class="value">{{ mcr?.mcr_status }}</span>
              </div>
              <div class="detail-item">
                <span class="label">Description</span>
                <span class="value">{{ mcr?.description || '—' }}</span>
              </div>
            </div>
          </mat-card-content>
        </mat-card>

        <!-- RACI Section -->
        @if (raci.length > 0) {
          <mat-card class="report-card">
            <mat-card-header>
              <mat-card-title>RACI Assignment</mat-card-title>
            </mat-card-header>
            <mat-card-content>
              <table class="raci-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Department</th>
                  </tr>
                </thead>
                <tbody>
                  @for (entry of raci; track entry) {
                    <tr>
                      <td>{{ entry.user_name || entry.name || '—' }}</td>
                      <td>
                        <span class="role-badge" [class]="'role-' + (entry.raci_role || entry.role || '').toLowerCase()">
                          {{ entry.raci_role || entry.role }}
                        </span>
                      </td>
                      <td>{{ entry.department_name || entry.department || '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </mat-card-content>
          </mat-card>
        }

        <!-- Progress -->
        <mat-card class="report-card">
          <mat-card-header>
            <mat-card-title>Progress Summary</mat-card-title>
          </mat-card-header>
          <mat-card-content>
            @if (taskStats) {
              <div class="progress-section">
                <div class="progress-item">
                  <span class="progress-label">Tasks Complete</span>
                  <div class="progress-bar-container">
                    <div class="progress-bar complete"
                         [style.width.%]="taskStats.completePercent"></div>
                  </div>
                  <span class="progress-value">{{ taskStats.complete }}/{{ taskStats.total }}</span>
                </div>
                <div class="progress-item">
                  <span class="progress-label">Ready / In Progress</span>
                  <div class="progress-bar-container">
                    <div class="progress-bar in-progress"
                         [style.width.%]="taskStats.readyPercent"></div>
                  </div>
                  <span class="progress-value">{{ taskStats.ready }}/{{ taskStats.total }}</span>
                </div>
                <div class="progress-item">
                  <span class="progress-label">Blocked / Failed</span>
                  <div class="progress-bar-container">
                    <div class="progress-bar blocked"
                         [style.width.%]="taskStats.blockedPercent"></div>
                  </div>
                  <span class="progress-value">{{ taskStats.blocked }}/{{ taskStats.total }}</span>
                </div>
              </div>
            }
          </mat-card-content>
        </mat-card>

        <!-- Task List -->
        @if (tasks.length > 0) {
          <mat-card class="report-card">
            <mat-card-header>
              <mat-card-title>Task List</mat-card-title>
            </mat-card-header>
            <mat-card-content class="table-container">
              <table mat-table [dataSource]="tasks" class="task-summary-table">
                <ng-container matColumnDef="task_seq">
                  <th mat-header-cell *matHeaderCellDef>#</th>
                  <td mat-cell *matCellDef="let t">{{ t.task_seq }}</td>
                </ng-container>
                <ng-container matColumnDef="title">
                  <th mat-header-cell *matHeaderCellDef>Title</th>
                  <td mat-cell *matCellDef="let t">{{ t.title }}</td>
                </ng-container>
                <ng-container matColumnDef="task_status">
                  <th mat-header-cell *matHeaderCellDef>Status</th>
                  <td mat-cell *matCellDef="let t">
                    <span class="status-chip" [class]="'status-' + (t.task_status || '').toLowerCase()">
                      {{ t.task_status }}
                    </span>
                  </td>
                </ng-container>
                <ng-container matColumnDef="jira_reference">
                  <th mat-header-cell *matHeaderCellDef>Jira</th>
                  <td mat-cell *matCellDef="let t">{{ t.jira_reference || '—' }}</td>
                </ng-container>
                <tr mat-header-row *matHeaderRowDef="taskColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: taskColumns;"></tr>
              </table>
            </mat-card-content>
          </mat-card>
        }
      </div>
    }
  `,
  styles: [`
    .loading-container, .error-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px;
      gap: 16px;
    }
    .report-container {
      max-width: 900px;
      margin: 0 auto;
      padding: 24px;
    }
    .report-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 24px;
    }
    .report-header h2 {
      margin: 0;
      font-size: 22px;
      font-weight: 500;
    }
    .spacer { flex: 1; }
    .report-card {
      margin-bottom: 16px;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      padding: 16px 0;
    }
    .detail-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .detail-item .label {
      font-size: 12px;
      color: rgba(0, 0, 0, 0.54);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .detail-item .value {
      font-size: 14px;
      font-weight: 500;
    }
    .raci-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
    }
    .raci-table th, .raci-table td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid #e0e0e0;
      font-size: 14px;
    }
    .raci-table th {
      font-weight: 500;
      color: rgba(0, 0, 0, 0.7);
      font-size: 12px;
      text-transform: uppercase;
    }
    .role-badge {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
    }
    .role-responsible, .role-r { background: #e3f2fd; color: #1565c0; }
    .role-accountable, .role-a { background: #fce4ec; color: #c62828; }
    .role-consulted, .role-c { background: #fff3e0; color: #e65100; }
    .role-informed, .role-i { background: #e8f5e9; color: #2e7d32; }
    .progress-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px 0;
    }
    .progress-item {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .progress-label {
      font-size: 13px;
      min-width: 140px;
      color: rgba(0, 0, 0, 0.7);
    }
    .progress-bar-container {
      flex: 1;
      height: 8px;
      background: #e0e0e0;
      border-radius: 4px;
      overflow: hidden;
    }
    .progress-bar {
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s ease;
    }
    .progress-bar.complete { background: #4caf50; }
    .progress-bar.in-progress { background: #1976d2; }
    .progress-bar.blocked { background: #f44336; }
    .progress-value {
      font-size: 13px;
      min-width: 40px;
      text-align: right;
      color: rgba(0, 0, 0, 0.7);
    }
    .table-container { overflow-x: auto; }
    .task-summary-table { width: 100%; }
    .status-chip {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
    }
    .status-complete, .status-completed { background: #e8f5e9; color: #2e7d32; }
    .status-ready { background: #e3f2fd; color: #1565c0; }
    .status-blocked { background: #fff3e0; color: #e65100; }
    .status-failed { background: #fce4ec; color: #c62828; }
    .status-cancelled { background: #f5f5f5; color: #616161; }
  `]
})
export class ReportComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly authService = inject(AuthService);

  mcr: any = null;
  tasks: any[] = [];
  raci: any[] = [];
  loading = true;
  error: string | null = null;
  sending = false;
  taskStats: {
    total: number; complete: number; ready: number; blocked: number;
    completePercent: number; readyPercent: number; blockedPercent: number;
  } | null = null;

  readonly taskColumns = ['task_seq', 'title', 'task_status', 'jira_reference'];

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id) {
      this.error = 'Invalid MCR ID';
      this.loading = false;
      return;
    }
    this.loadReport(id);
  }

  private async loadReport(id: number): Promise<void> {
    this.loading = true;
    this.cdr.detectChanges();

    try {
      // Fetch MCR details
      const mcrRes = await fetch(`/ords/jit_schema/mcr/v1/requests/${id}`);
      if (mcrRes.ok) {
        this.mcr = await mcrRes.json();
        // Extract RACI if embedded
        this.raci = this.mcr?.raci ?? [];
      } else {
        this.error = 'Failed to load MCR details.';
        this.loading = false;
        this.cdr.detectChanges();
        return;
      }
    } catch {
      this.error = 'Failed to load MCR details.';
      this.loading = false;
      this.cdr.detectChanges();
      return;
    }

    try {
      // Fetch tasks
      const taskRes = await fetch(`/ords/jit_schema/mcr/v1/tasks/mcr/${id}`);
      if (taskRes.ok) {
        const data = await taskRes.json();
        this.tasks = data?.items ?? (Array.isArray(data) ? data : []);
      }
    } catch {
      this.tasks = [];
    }

    // Try to fetch RACI separately if not already embedded
    if (this.raci.length === 0) {
      try {
        const raciRes = await fetch(`/ords/jit_schema/mcr/v1/requests/${id}/raci`);
        if (raciRes.ok) {
          const raciData = await raciRes.json();
          this.raci = raciData?.items ?? (Array.isArray(raciData) ? raciData : []);
        }
      } catch {
        // RACI endpoint might not exist — that's fine
      }
    }

    this.calculateStats(this.tasks);
    this.loading = false;
    this.cdr.detectChanges();
  }

  private calculateStats(tasks: any[]): void {
    const total = tasks.length || 1;
    const complete = tasks.filter((t: any) =>
      ['COMPLETE', 'COMPLETED'].includes((t.task_status || t.status || '').toUpperCase())
    ).length;
    const ready = tasks.filter((t: any) =>
      ['READY', 'IN_PROGRESS', 'IN PROGRESS'].includes((t.task_status || t.status || '').toUpperCase())
    ).length;
    const blocked = tasks.filter((t: any) =>
      ['BLOCKED', 'FAILED'].includes((t.task_status || t.status || '').toUpperCase())
    ).length;

    this.taskStats = {
      total: tasks.length,
      complete,
      ready,
      blocked,
      completePercent: (complete / total) * 100,
      readyPercent: (ready / total) * 100,
      blockedPercent: (blocked / total) * 100
    };
  }

  async sendReport(): Promise<void> {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    this.sending = true;
    this.cdr.detectChanges();

    try {
      const userId = this.authService.getCurrentUserId();
      const res = await fetch(`/ords/jit_schema/mcr/v1/requests/${id}/send-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId })
      });

      if (res.ok) {
        this.snackBar.open('Report sent successfully', 'OK', { duration: 3000 });
      } else {
        this.snackBar.open('Failed to send report', 'OK', { duration: 4000 });
      }
    } catch {
      this.snackBar.open('Network error sending report', 'OK', { duration: 4000 });
    }

    this.sending = false;
    this.cdr.detectChanges();
  }

  goBack(): void {
    this.router.navigate(['/active']);
  }
}
