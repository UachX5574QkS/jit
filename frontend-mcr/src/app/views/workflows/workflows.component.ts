import {
  Component,
  OnInit,
  inject,
  ChangeDetectorRef,
  ElementRef,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { WorkflowGraphDialogComponent } from './workflow-graph-dialog.component';

@Component({
  selector: 'app-workflows',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatDialogModule
  ],
  template: `
    <h2>Workflows</h2>

    @if (loading) {
      <div class="loading-container">
        <mat-spinner diameter="40"></mat-spinner>
      </div>
    } @else if (error) {
      <p class="error-text">{{ error }}</p>
    } @else {
      <mat-card class="workflows-card">
        <table class="workflows-table" aria-label="Workflow change types">
          <thead>
            <tr>
              <th>Type Name</th>
              <th>Workflow Name</th>
              <th>Description</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (ct of changeTypes; track ct.type_id) {
              <tr>
                <td>
                  <mat-icon class="type-icon">{{ ct.icon }}</mat-icon>
                  {{ ct.type_name }}
                </td>
                <td>{{ ct.workflow_name }}</td>
                <td>{{ ct.description }}</td>
                <td>
                  <button mat-stroked-button (click)="viewWorkflow(ct)">
                    <mat-icon>visibility</mat-icon> View
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </mat-card>
    }
  `,
  styles: [`
    h2 {
      margin: 0 0 16px;
      font-size: 22px;
      font-weight: 600;
    }
    .loading-container {
      display: flex;
      justify-content: center;
      padding: 48px;
    }
    .error-text {
      color: #D5281B;
      text-align: center;
      padding: 24px;
    }
    .workflows-card {
      padding: 20px;
      border-radius: 12px;
    }
    .workflows-table {
      width: 100%;
      border-collapse: collapse;
    }
    .workflows-table th,
    .workflows-table td {
      text-align: left;
      padding: 12px 16px;
      border-bottom: 1px solid var(--color-line, #E8E4EE);
    }
    .workflows-table th {
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--color-ink-2, #5B5B6E);
    }
    .workflows-table td {
      font-size: 14px;
    }
    .type-icon {
      vertical-align: middle;
      margin-right: 8px;
      font-size: 20px;
      width: 20px;
      height: 20px;
      color: var(--color-nw-purple, #5A287D);
    }
  `]
})
export class WorkflowsComponent implements OnInit {
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly dialog = inject(MatDialog);

  changeTypes: any[] = [];
  loading = true;
  error: string | null = null;

  ngOnInit(): void {
    this.loadChangeTypes();
  }

  private async loadChangeTypes(): Promise<void> {
    this.loading = true;
    this.cdr.detectChanges();

    try {
      const res = await fetch('/ords/jit_schema/mcr/v1/workflows/');
      if (res.ok) {
        const data = await res.json();
        this.changeTypes = data?.items ?? (Array.isArray(data) ? data : []);
      } else {
        this.error = 'Failed to load workflow data.';
      }
    } catch {
      this.error = 'Failed to load workflow data.';
    }

    this.loading = false;
    this.cdr.detectChanges();
  }

  viewWorkflow(ct: any): void {
    this.dialog.open(WorkflowGraphDialogComponent, {
      width: '95vw',
      maxWidth: '95vw',
      data: {
        workflowId: ct.workflow_id,
        workflowName: ct.workflow_name,
        typeName: ct.type_name
      }
    });
  }
}
