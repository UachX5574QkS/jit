import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { Router } from '@angular/router';
import { MatTableModule } from '@angular/material/table';
import { MatSortModule, Sort } from '@angular/material/sort';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { AuthService } from '../../services/auth.service';


@Component({
  selector: 'app-active',
  standalone: true,
  imports: [
    MatTableModule,
    MatSortModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatDialogModule
  ],
  template: `
    <div class="view-container">
      <h2>Active MCRs</h2>

      @if (loading) {
        <div class="loading-container">
          <mat-spinner diameter="40"></mat-spinner>
        </div>
      } @else if (mcrs.length === 0) {
        <p class="empty-text">No active MCRs found.</p>
      } @else {
        <mat-card>
          <mat-card-content class="table-container">
            <table mat-table [dataSource]="sortedMcrs" matSort (matSortChange)="onSort($event)" class="mcr-table">

              <!-- MCR Number (clickable link) -->
              <ng-container matColumnDef="mcr_number">
                <th mat-header-cell *matHeaderCellDef mat-sort-header>MCR Number</th>
                <td mat-cell *matCellDef="let mcr" (click)="$event.stopPropagation()">
                  <span class="mcr-link" (click)="editMCR(mcr)">{{ mcr.mcr_number }}</span>
                </td>
              </ng-container>

              <!-- Owner -->
              <ng-container matColumnDef="owner">
                <th mat-header-cell *matHeaderCellDef mat-sort-header>Owner</th>
                <td mat-cell *matCellDef="let mcr">{{ mcr.owner_name || '—' }}</td>
              </ng-container>

              <!-- Description -->
              <ng-container matColumnDef="description">
                <th mat-header-cell *matHeaderCellDef mat-sort-header>Description</th>
                <td mat-cell *matCellDef="let mcr" class="description-cell">{{ mcr.description || '—' }}</td>
              </ng-container>

              <!-- Start Date -->
              <ng-container matColumnDef="start_date">
                <th mat-header-cell *matHeaderCellDef mat-sort-header>Start Date</th>
                <td mat-cell *matCellDef="let mcr">{{ formatDate(mcr.estimated_start_date) }}</td>
              </ng-container>

              <!-- End Date -->
              <ng-container matColumnDef="end_date">
                <th mat-header-cell *matHeaderCellDef mat-sort-header>End Date</th>
                <td mat-cell *matCellDef="let mcr">{{ formatDate(mcr.estimated_end_date) }}</td>
              </ng-container>

              <!-- Status -->
              <ng-container matColumnDef="status">
                <th mat-header-cell *matHeaderCellDef mat-sort-header>Status</th>
                <td mat-cell *matCellDef="let mcr">
                  <span class="status-chip" [class]="'status-' + (mcr.mcr_status || '').toLowerCase()">
                    {{ mcr.mcr_status }}
                  </span>
                </td>
              </ng-container>

              <!-- Progress -->
              <ng-container matColumnDef="progress">
                <th mat-header-cell *matHeaderCellDef>Progress</th>
                <td mat-cell *matCellDef="let mcr">
                  <div class="progress-cell">
                    <div class="mini-progress-bar">
                      <div class="mini-progress-fill"
                           [style.width.%]="getProgressPercent(mcr)"></div>
                    </div>
                    <span class="progress-text">{{ mcr.tasks_complete || 0 }}/{{ mcr.total_tasks || 0 }}</span>
                  </div>
                </td>
              </ng-container>

              <!-- Actions (includes lifecycle icons) -->
              <ng-container matColumnDef="actions">
                <th mat-header-cell *matHeaderCellDef>Actions</th>
                <td mat-cell *matCellDef="let mcr">
                  <div class="action-buttons" (click)="$event.stopPropagation()">
                    @if (mcr.mcr_status === 'Ready') {
                      <button mat-icon-button matTooltip="Approve MCR" (click)="approveMCR(mcr)" class="approve-icon">
                        <mat-icon>check_circle</mat-icon>
                      </button>
                    }
                    @if (mcr.mcr_status === 'Approved' && isWithinWindow(mcr)) {
                      <button mat-icon-button matTooltip="Start MCR" (click)="startMCR(mcr)" class="start-icon">
                        <mat-icon>play_circle_filled</mat-icon>
                      </button>
                    }
                    @if (mcr.mcr_status === 'Active' || mcr.mcr_status === 'Active_Late') {
                      <button mat-icon-button matTooltip="End MCR" (click)="endMCR(mcr)" class="end-icon">
                        <mat-icon>stop_circle</mat-icon>
                      </button>
                    }
                    <button mat-icon-button matTooltip="Dependency Map" (click)="openMap(mcr)" class="map-icon">
                      <mat-icon>account_tree</mat-icon>
                    </button>
                    <button mat-icon-button matTooltip="Documents" (click)="viewDocs(mcr)" class="docs-icon">
                      <mat-icon>folder_open</mat-icon>
                    </button>
                    <button mat-icon-button matTooltip="Report" (click)="viewReport(mcr)" class="report-icon">
                      <mat-icon>assessment</mat-icon>
                    </button>
                  </div>
                </td>
              </ng-container>

              <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
              <tr mat-row *matRowDef="let row; columns: displayedColumns;"
                  (click)="viewDetails(row)" class="clickable-row"></tr>
            </table>
          </mat-card-content>
        </mat-card>
      }
    </div>
  `,
  styles: [`
    .view-container h2 {
      margin: 0 0 16px;
      font-size: 16px;
      font-weight: 700;
      color: var(--color-ink);
    }
    .loading-container {
      display: flex;
      justify-content: center;
      padding: 48px;
    }
    .empty-text {
      color: var(--color-ink-3);
      font-size: 14px;
    }
    .table-container {
      overflow-x: auto;
    }
    .mcr-table {
      width: 100%;
    }
    .description-cell {
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .clickable-row {
      cursor: pointer;
    }
    .clickable-row:hover {
      background: var(--color-nw-purple-bg) !important;
    }
    .mcr-link {
      cursor: pointer;
      color: var(--color-nw-purple);
      font-weight: 500;
    }
    .mcr-link:hover {
      text-decoration: underline;
    }
    .approve-icon { color: #4caf50; }
    .status-chip {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      text-transform: uppercase;
    }
    .status-active, .status-in_progress { background: var(--color-nw-purple-bg); color: var(--color-nw-purple); }
    .status-active_late { background: #fff3e0; color: #e65100; }
    .status-approved { background: #e6f7ed; color: var(--color-green); }
    .status-ready { background: #e3f2fd; color: #1565c0; }
    .status-draft { background: var(--color-bg); color: var(--color-ink-2); }
    .status-locked { background: #fff7e6; color: var(--color-amber); }
    .status-cancelled { background: #fde8e7; color: var(--color-red); }
    .status-complete { background: #e6f7ed; color: var(--color-green); }
    .progress-cell {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .mini-progress-bar {
      width: 60px;
      height: 6px;
      background: var(--color-line);
      border-radius: 3px;
      overflow: hidden;
    }
    .mini-progress-fill {
      height: 100%;
      background: var(--color-green);
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    .progress-text {
      font-size: 12px;
      color: var(--color-ink-2);
      white-space: nowrap;
    }
    .action-buttons {
      display: flex;
      gap: 0;
    }
    .action-buttons button {
      width: 36px;
      height: 36px;
    }
    .start-icon { color: #4caf50; }
    .end-icon { color: #f44336; }
    .action-buttons button.map-icon { color: #2196F3; }
    .action-buttons button.docs-icon { color: #FF9800; }
    .action-buttons button.report-icon { color: #9C27B0; }
  `]
})
export class ActiveComponent implements OnInit {
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly authService = inject(AuthService);

  mcrs: any[] = [];
  sortedMcrs: any[] = [];
  loading = true;

  readonly displayedColumns = [
    'mcr_number', 'owner', 'description', 'start_date', 'end_date',
    'status', 'progress', 'actions'
  ];

  ngOnInit(): void {
    this.loadMCRs();
  }

  async loadMCRs(): Promise<void> {
    this.loading = true;
    this.cdr.detectChanges();

    try {
      const response = await fetch('/ords/jit_schema/mcr/v1/requests/');
      const data = await response.json();
      this.mcrs = data?.items ?? (Array.isArray(data) ? data : []);
    } catch {
      this.mcrs = [];
    }
    this.sortedMcrs = [...this.mcrs];
    this.loading = false;
    this.cdr.detectChanges();
  }

  formatDate(dateStr: string | null): string {
    if (!dateStr) return '—';
    const parts = dateStr.split('-');
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }

  getProgressPercent(mcr: any): number {
    const total = mcr.total_tasks || 0;
    if (total === 0) return 0;
    return ((mcr.tasks_complete || 0) / total) * 100;
  }

  isWithinWindow(mcr: any): boolean {
    if (!mcr.estimated_start_date || !mcr.estimated_end_date) return false;
    const now = new Date();
    const start = new Date(mcr.estimated_start_date);
    const end = new Date(mcr.estimated_end_date);
    end.setHours(23, 59, 59); // End of day
    return now >= start && now <= end;
  }

  onSort(sort: Sort): void {
    if (!sort.active || sort.direction === '') {
      this.sortedMcrs = [...this.mcrs];
      return;
    }
    this.sortedMcrs = [...this.mcrs].sort((a, b) => {
      const aVal = a[sort.active] ?? '';
      const bVal = b[sort.active] ?? '';
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sort.direction === 'asc' ? cmp : -cmp;
    });
    this.cdr.detectChanges();
  }

  viewDetails(mcr: any): void {
    this.router.navigate(['/active', mcr.mcr_id]);
  }

  editMCR(mcr: any): void {
    this.router.navigate(['/edit', mcr.mcr_id]);
  }

  async approveMCR(mcr: any): Promise<void> {
    await fetch(`/ords/jit_schema/mcr/v1/requests/${mcr.mcr_id}/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', user_id: this.authService.getCurrentUserId() })
    });
    await this.loadMCRs();
  }

  async startMCR(mcr: any): Promise<void> {
    const userId = this.authService.getCurrentUserId();
    const res = await fetch(`/ords/jit_schema/mcr/v1/requests/${mcr.mcr_id}/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', user_id: userId })
    });
    if (res.ok) {
      mcr.mcr_status = 'Active';
      this.cdr.detectChanges();
    }
  }

  endMCR(mcr: any): void {
    import('./end-mcr-dialog.component').then(m => {
      const dialogRef = this.dialog.open(m.EndMCRDialogComponent, { width: '450px' });
      dialogRef.afterClosed().subscribe(async (result) => {
        if (result && result.action) {
          const userId = this.authService.getCurrentUserId();
          await fetch(`/ords/jit_schema/mcr/v1/requests/${mcr.mcr_id}/lifecycle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: result.action, user_id: userId, notes: result.notes })
          });
          await this.loadMCRs();
        }
      });
    });
  }

  openMap(mcr: any): void {
    import('../../components/dependency-map/dependency-map-dialog.component').then(m => {
      this.dialog.open(m.DependencyMapDialogComponent, {
        width: '800px',
        maxHeight: '90vh',
        data: { mcrId: mcr.mcr_id, mcrNumber: mcr.mcr_number }
      });
    });
  }

  viewDocs(mcr: any): void {
    import('./mcr-docs-dialog.component').then(m => {
      this.dialog.open(m.MCRDocsDialogComponent, {
        width: '900px',
        data: { mcrId: mcr.mcr_id, mcrNumber: mcr.mcr_number }
      });
    });
  }

  viewReport(mcr: any): void {
    this.router.navigate(['/active', mcr.mcr_id, 'report']);
  }
}
