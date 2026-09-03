import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { Router } from '@angular/router';
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
      <h2>Archived Changes</h2>

      @if (loading) {
        <div class="loading-container">
          <mat-spinner diameter="40"></mat-spinner>
        </div>
      } @else if (mcrs.length === 0) {
        <p class="empty-text">No archived changes found.</p>
      } @else {
        @for (group of mcrGroups; track group.type) {
          <section class="type-section">
            <h3>{{ group.type }}</h3>
            <mat-card>
              <mat-card-content class="table-container">
                <table mat-table [dataSource]="group.items" class="mcr-table">

                  <!-- MCR Number -->
                  <ng-container matColumnDef="mcr_number">
                    <th mat-header-cell *matHeaderCellDef>Reference</th>
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

                  <!-- Start Date -->
                  <ng-container matColumnDef="start_date">
                    <th mat-header-cell *matHeaderCellDef>Start Date</th>
                    <td mat-cell *matCellDef="let mcr">{{ formatDate(mcr.estimated_start_date) }}</td>
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
                  <tr mat-row *matRowDef="let row; columns: displayedColumns;" class="clickable-row" (click)="viewDetails(row)"></tr>
                </table>
              </mat-card-content>
            </mat-card>
          </section>
        }
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
    .clickable-row {
      cursor: pointer;
      transition: background-color 0.15s;
    }
    .clickable-row:hover {
      background-color: var(--color-nw-purple-bg, #F3EFF8);
    }
    .type-section { margin-bottom: 24px; }
    .type-section h3 { font-size: 15px; font-weight: 600; margin: 0 0 8px; color: var(--color-nw-purple); }
  `]
})
export class ArchivedComponent implements OnInit {
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly router = inject(Router);

  mcrs: any[] = [];
  mcrGroups: { type: string; items: any[] }[] = [];
  loading = true;

  readonly displayedColumns = ['mcr_number', 'owner_name', 'description', 'start_date', 'mcr_status'];

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
    const types = ['MCR', 'Standard Change', 'Standard Activity'];
    this.mcrGroups = types
      .map(type => ({
        type,
        items: this.mcrs.filter(m => (m.change_type || 'MCR') === type)
      }))
      .filter(g => g.items.length > 0);
    this.loading = false;
    this.cdr.detectChanges();
  }

  viewDetails(mcr: any): void {
    this.router.navigate(['/active', mcr.mcr_id]);
  }

  formatDate(dateStr: string | null): string {
    if (!dateStr) return '—';
    const parts = dateStr.split('-');
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return dateStr;
  }
}
