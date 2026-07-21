import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { AuthService } from '../../services/auth.service';

export interface MCRDocsDialogData { mcrId: number; mcrNumber: string; }

@Component({
  selector: 'app-mcr-docs-dialog',
  standalone: true,
  imports: [MatDialogModule, MatTableModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule, MatSnackBarModule],
  template: `
    <h2 mat-dialog-title>Documents — {{ data.mcrNumber }}</h2>
    <mat-dialog-content>
      @if (loading) {
        <div style="display:flex;justify-content:center;padding:32px"><mat-spinner diameter="32"></mat-spinner></div>
      } @else if (docs.length === 0) {
        <p>No documents found.</p>
      } @else {
        <table mat-table [dataSource]="docs" style="width:100%">
          <ng-container matColumnDef="title"><th mat-header-cell *matHeaderCellDef>Type</th><td mat-cell *matCellDef="let d">{{ d.title }}</td></ng-container>
          <ng-container matColumnDef="doc_description"><th mat-header-cell *matHeaderCellDef>Description</th><td mat-cell *matCellDef="let d">{{ d.doc_description || '—' }}</td></ng-container>
          <ng-container matColumnDef="uploaded_by_name"><th mat-header-cell *matHeaderCellDef>Uploaded By</th><td mat-cell *matCellDef="let d">{{ d.uploaded_by_name || '—' }}</td></ng-container>
          <ng-container matColumnDef="uploaded_at"><th mat-header-cell *matHeaderCellDef>Uploaded</th><td mat-cell *matCellDef="let d">{{ d.uploaded_at }}</td></ng-container>
          <ng-container matColumnDef="approved_by_name"><th mat-header-cell *matHeaderCellDef>Approved By</th><td mat-cell *matCellDef="let d">{{ d.approved_by_name || '—' }}</td></ng-container>
          <ng-container matColumnDef="approved_at_str"><th mat-header-cell *matHeaderCellDef>Approved</th><td mat-cell *matCellDef="let d">{{ d.approved_at_str || '—' }}</td></ng-container>
          <ng-container matColumnDef="actions"><th mat-header-cell *matHeaderCellDef></th>
            <td mat-cell *matCellDef="let d" (click)="$event.stopPropagation()">
              @if (!d.approved_by_user_id) {
                <button mat-stroked-button (click)="approveDoc(d)" style="font-size:11px">Approve</button>
              }
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="columns"></tr>
          <tr mat-row *matRowDef="let row; columns: columns;"></tr>
        </table>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end"><button mat-button mat-dialog-close>Close</button></mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { min-width: 850px; overflow-x: hidden; }
  `]
})
export class MCRDocsDialogComponent implements OnInit {
  readonly data: MCRDocsDialogData = inject(MAT_DIALOG_DATA);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly snackBar = inject(MatSnackBar);
  private readonly authService = inject(AuthService);
  docs: any[] = [];
  loading = true;
  readonly columns = ['title', 'doc_description', 'uploaded_by_name', 'uploaded_at', 'approved_by_name', 'approved_at_str', 'actions'];

  ngOnInit(): void { this.loadDocs(); }

  async loadDocs(): Promise<void> {
    this.loading = true;
    this.cdr.detectChanges();
    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/documents/mcr/${this.data.mcrId}`);
      if (res.ok) { const d = await res.json(); this.docs = d?.items ?? []; }
    } catch { /* ignore */ }
    this.loading = false;
    this.cdr.detectChanges();
  }

  async approveDoc(doc: any): Promise<void> {
    const userId = this.authService.getCurrentUserId();
    const res = await fetch('/ords/jit_schema/mcr/v1/documents/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document_id: doc.document_id, user_id: userId })
    });
    if (res.ok) {
      this.snackBar.open('Document approved', 'OK', { duration: 3000 });
      this.loadDocs();
    }
  }
}
