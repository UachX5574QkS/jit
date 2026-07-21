import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [
    MatCardModule,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatDialogModule,
    MatSnackBarModule,
    MatProgressSpinnerModule
  ],
  template: `
    <div class="view-container">
      <h2>Admin</h2>

      <section class="teams-section">
        <div class="section-header">
          <h3>Teams</h3>
          <button mat-raised-button color="primary" (click)="openCreateTeamDialog()">
            <mat-icon>add</mat-icon> New Team
          </button>
        </div>

        @if (loading) {
          <div class="loading-container">
            <mat-spinner diameter="40"></mat-spinner>
          </div>
        } @else if (teams.length === 0) {
          <p class="empty-text">No teams found.</p>
        } @else {
          <mat-card>
            <mat-card-content class="table-container">
              <table mat-table [dataSource]="teams" class="teams-table">
                <ng-container matColumnDef="team_name">
                  <th mat-header-cell *matHeaderCellDef>Team Name</th>
                  <td mat-cell *matCellDef="let team">{{ team.team_name }}</td>
                </ng-container>

                <ng-container matColumnDef="description">
                  <th mat-header-cell *matHeaderCellDef>Description</th>
                  <td mat-cell *matCellDef="let team">{{ team.description || '—' }}</td>
                </ng-container>

                <ng-container matColumnDef="members">
                  <th mat-header-cell *matHeaderCellDef>Members</th>
                  <td mat-cell *matCellDef="let team">{{ team.members || team.member_count || '—' }}</td>
                </ng-container>

                <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: displayedColumns;"></tr>
              </table>
            </mat-card-content>
          </mat-card>
        }
      </section>
    </div>
  `,
  styles: [`
    .view-container h2 {
      margin: 0 0 16px;
      font-size: 16px;
      font-weight: 700;
      color: var(--color-ink);
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .section-header h3 {
      margin: 0;
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
    .teams-table {
      width: 100%;
    }
  `]
})
export class AdminComponent implements OnInit {
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);

  teams: any[] = [];
  loading = true;

  readonly displayedColumns = ['team_name', 'description', 'members'];

  ngOnInit(): void {
    this.loadTeams();
  }

  async loadTeams(): Promise<void> {
    this.loading = true;
    this.cdr.detectChanges();

    try {
      const res = await fetch('/ords/jit_schema/mcr/v1/users/teams');
      if (res.ok) {
        const data = await res.json();
        this.teams = data?.items ?? (Array.isArray(data) ? data : []);
      } else {
        this.teams = [];
      }
    } catch {
      this.teams = [];
    }

    this.loading = false;
    this.cdr.detectChanges();
  }

  openCreateTeamDialog(): void {
    import('./create-team-dialog/create-team-dialog.component').then(m => {
      const dialogRef = this.dialog.open(m.CreateTeamDialogComponent, {
        width: '500px'
      });
      dialogRef.afterClosed().subscribe(result => {
        if (result) {
          this.loadTeams();
        }
      });
    });
  }
}
