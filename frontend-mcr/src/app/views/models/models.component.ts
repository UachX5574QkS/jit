import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

@Component({
  selector: 'app-models',
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
      <div class="section-header">
        <h2>Models</h2>
        <button mat-raised-button color="primary" (click)="openCreateModelDialog()">
          <mat-icon>add</mat-icon> New Model
        </button>
      </div>

      @if (loading) {
        <div class="loading-container">
          <mat-spinner diameter="40"></mat-spinner>
        </div>
      } @else if (models.length === 0) {
        <p class="empty-text">No models found. Create a reusable task template to get started.</p>
      } @else {
        @for (group of modelGroups; track group.type) {
          <section class="type-section">
            <h3>{{ group.type }}</h3>
            <mat-card>
              <mat-card-content class="table-container">
                <table mat-table [dataSource]="group.items" class="models-table">
                  <ng-container matColumnDef="model_name">
                    <th mat-header-cell *matHeaderCellDef>Name</th>
                    <td mat-cell *matCellDef="let model">
                      <a class="model-link" (click)="openModelDetail(model)">{{ model.model_name }}</a>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="description">
                    <th mat-header-cell *matHeaderCellDef>Description</th>
                    <td mat-cell *matCellDef="let model" class="description-cell">{{ model.description || '—' }}</td>
                  </ng-container>

                  <ng-container matColumnDef="task_count">
                    <th mat-header-cell *matHeaderCellDef>Tasks</th>
                    <td mat-cell *matCellDef="let model">{{ model.task_count ?? '—' }}</td>
                  </ng-container>

                  <ng-container matColumnDef="actions">
                    <th mat-header-cell *matHeaderCellDef>Actions</th>
                    <td mat-cell *matCellDef="let model">
                      <button mat-icon-button color="primary" (click)="openModelDetail(model)" aria-label="Edit model">
                        <mat-icon>edit</mat-icon>
                      </button>
                      <button mat-icon-button color="warn" (click)="deleteModel(model)" aria-label="Delete model">
                        <mat-icon>delete</mat-icon>
                      </button>
                    </td>
                  </ng-container>

                  <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
                  <tr mat-row *matRowDef="let row; columns: displayedColumns;"></tr>
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
      margin: 0;
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
    .models-table {
      width: 100%;
    }
    .description-cell {
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .model-link {
      color: var(--color-nw-purple, #5A287D);
      cursor: pointer;
      font-weight: 500;
      text-decoration: none;
    }
    .model-link:hover {
      text-decoration: underline;
    }
    .type-section { margin-bottom: 24px; }
    .type-section h3 { font-size: 15px; font-weight: 600; margin: 0 0 8px; color: var(--color-nw-purple); }
  `]
})
export class ModelsComponent implements OnInit {
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);

  models: any[] = [];
  modelGroups: { type: string; items: any[] }[] = [];
  loading = true;

  readonly displayedColumns = ['model_name', 'description', 'task_count', 'actions'];

  ngOnInit(): void {
    this.loadModels();
  }

  async loadModels(): Promise<void> {
    this.loading = true;
    this.cdr.detectChanges();

    try {
      const res = await fetch('/ords/jit_schema/mcr/v1/models/');
      if (res.ok) {
        const data = await res.json();
        this.models = data?.items ?? (Array.isArray(data) ? data : []);
      } else {
        this.models = [];
      }
    } catch {
      this.models = [];
    }

    const types = ['MCR', 'Standard Change', 'Standard Activity'];
    this.modelGroups = types
      .map(type => ({
        type,
        items: this.models.filter(m => (m.change_type || 'MCR') === type)
      }))
      .filter(g => g.items.length > 0);
    this.loading = false;
    this.cdr.detectChanges();
  }

  openCreateModelDialog(): void {
    import('../admin/create-model-dialog/create-model-dialog.component').then(m => {
      const dialogRef = this.dialog.open(m.CreateModelDialogComponent, {
        width: '500px'
      });
      dialogRef.afterClosed().subscribe(result => {
        if (result) {
          this.loadModels();
        }
      });
    });
  }

  openModelDetail(model: any): void {
    import('../admin/model-detail-dialog/model-detail-dialog.component').then(m => {
      const dialogRef = this.dialog.open(m.ModelDetailDialogComponent, {
        width: '95vw',
        maxWidth: '95vw',
        maxHeight: '90vh',
        data: { model_id: model.model_id }
      });
      dialogRef.afterClosed().subscribe(() => {
        this.loadModels();
      });
    });
  }

  async deleteModel(model: any): Promise<void> {
    if (!confirm(`Delete model "${model.model_name}"? This will also delete all its tasks.`)) return;

    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/models/${model.model_id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        this.snackBar.open('Model deleted', 'Close', { duration: 3000 });
        await this.loadModels();
      } else {
        this.snackBar.open('Failed to delete model', 'Close', { duration: 5000 });
      }
    } catch (e: any) {
      this.snackBar.open('Network error: ' + e.message, 'Close', { duration: 5000 });
    }
    this.cdr.detectChanges();
  }
}
