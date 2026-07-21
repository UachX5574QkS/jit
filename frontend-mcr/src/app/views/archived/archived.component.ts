import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { MatTableModule } from '@angular/material/table';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

@Component({
  selector: 'app-archived',
  standalone: true,
  imports: [
    MatTableModule,
    MatCardModule,
    MatProgressSpinnerModule
  ],
  template: `
    <div class="view-container">
      <h2>Archived MCRs</h2>

      @if (loading) {
        <div class="loading-container">
          <mat-spinner diameter="40"></mat-spinner>
        </div>
      } @else if (mcrs.length === 0) {
        <p class="empty-text">No archived MCRs found.</p>
      } @else {
        <mat-card>
          <mat-card-content class="table-container">
            <table mat-table [dataSource]="mcrs" class="mcr-table">

              <!-- MCR Number -->
              <ng-container matColumnDef="mcr_number">
                <th mat-header-cell *matHeaderCellDef>MCR Number</th>
                <td mat-cell *matCellDef="let mcr">{{ mcr.mcr_number }}</td>
              </ng-container>

              <!-- Owner -->
              <ng-container matColumnDef="owner_name">
                <th mat-header-cell *matHeaderCellDef>Owner</th>
                <td mat-cell *matCellDef="let mcr">{{ mcr.owner_name }}</td>
              </ng-container>

              <!-- Description -->
              <ng-container matColumnDef="description">
                <th mat-header-cell *matHeaderCellDef>Description</th>
                <td mat-cell *matCellDef="let mcr" class="description-cell">{{ mcr.description }}</td>
              </ng-container>

              <!-- Status -->
              <ng-container matColumnDef="mcr_status">
                <th mat-header-cell *matHeaderCellDef>Status</th>
                <td mat-cell *matCellDef="let mcr">
                  <span class="status-chip" [class]="'status-' + (mcr.mcr_status || '').toLowerCase()">
                    {{ mcr.mcr_status }}
                  </span>
                </td>
              </ng-container>

              <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
              <tr mat-row *matRowDef="let row; columns: displayedColumns;"></tr>
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
    .status-chip {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
    }
    .status-completed, .status-complete { background: #e6f7ed; color: var(--color-green); }
    .status-cancelled { background: var(--color-bg); color: var(--color-ink-2); }
    .status-failed { background: #fde8e7; color: var(--color-red); }
  `]
})
export class ArchivedComponent implements OnInit {
  private readonly cdr = inject(ChangeDetectorRef);

  mcrs: any[] = [];
  loading = true;

  readonly displayedColumns = ['mcr_number', 'owner_name', 'description', 'mcr_status'];

  ngOnInit(): void {
    this.loadArchived();
  }

  async loadArchived(): Promise<void> {
    this.loading = true;
    this.cdr.detectChanges();

    try {
      const response = await fetch('/ords/jit_schema/mcr/v1/requests/archived');
      const data = await response.json();
      this.mcrs = data?.items ?? (Array.isArray(data) ? data : []);
    } catch {
      this.mcrs = [];
    }
    this.loading = false;
    this.cdr.detectChanges();
  }
}
