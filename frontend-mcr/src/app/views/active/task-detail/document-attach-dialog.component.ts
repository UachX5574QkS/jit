import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatListModule } from '@angular/material/list';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../../services/auth.service';

export interface DocumentAttachDialogData {
  mcrId: number;
  taskId: number;
  taskTitle: string;
}

@Component({
  selector: 'app-document-attach-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatCheckboxModule,
    MatListModule,
    MatSnackBarModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    FormsModule
  ],
  template: `
    <h2 mat-dialog-title>Documents — {{ data.taskTitle }}</h2>
    <mat-dialog-content>
      @if (loading) {
        <div class="loading-container">
          <mat-spinner diameter="32"></mat-spinner>
        </div>
      } @else {
        <div class="doc-section">
          <h4>MCR Documents</h4>
          @if (documents.length === 0) {
            <p class="empty-text">No documents found for this MCR.</p>
          } @else {
            <div class="doc-list">
              @for (doc of documents; track doc.document_id) {
                <div class="doc-item">
                  <mat-checkbox [checked]="isLinked(doc.document_id)"
                                (change)="toggleLink(doc.document_id, $event.checked)">
                    {{ doc.title }}
                  </mat-checkbox>
                  <span class="doc-meta">
                    {{ doc.doc_description ? '— ' + doc.doc_description : '' }}
                    {{ doc.uploaded_by_name ? ' (by ' + doc.uploaded_by_name + ')' : '' }}
                  </span>
                </div>
              }
            </div>
          }
        </div>

        <div class="upload-section">
          <h4>Upload New Document</h4>
          <mat-form-field appearance="outline" class="full-width">
            <mat-label>Document Type</mat-label>
            <mat-select [(ngModel)]="uploadDocType">
              @for (docType of documentTypes; track docType.doc_type_id) {
                <mat-option [value]="docType.type_name">{{ docType.type_name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline" class="full-width">
            <mat-label>Description (optional)</mat-label>
            <input matInput [(ngModel)]="uploadDescription" placeholder="Brief description of this document" />
          </mat-form-field>
          <div class="file-row">
            <button mat-stroked-button (click)="fileInput.click()">
              <mat-icon>attach_file</mat-icon> Choose File
            </button>
            <span class="file-name">{{ selectedFile?.name || 'No file selected' }}</span>
            <input #fileInput type="file" hidden (change)="onFileSelected($event)" />
          </div>
          <button mat-raised-button color="primary" (click)="uploadDocument()"
                  [disabled]="!uploadDocType || !selectedFile || uploading" class="upload-btn">
            {{ uploading ? 'Uploading...' : 'Upload' }}
          </button>
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-stroked-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="saveLinks()" [disabled]="saving">
        {{ saving ? 'Saving...' : 'Save Links' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .loading-container { display: flex; justify-content: center; padding: 32px; }
    .empty-text { color: rgba(0, 0, 0, 0.54); font-size: 14px; }
    .doc-section, .upload-section { margin-bottom: 16px; }
    .doc-section h4, .upload-section h4 {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--color-nw-purple, #5A287D);
      margin: 0 0 8px;
    }
    .doc-list { display: flex; flex-direction: column; gap: 4px; }
    .doc-item { display: flex; align-items: center; gap: 8px; }
    .doc-meta { font-size: 11px; color: rgba(0,0,0,0.45); }
    .full-width { width: 100%; }
    .file-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .file-name { font-size: 12px; color: rgba(0,0,0,0.54); }
    .upload-btn { margin-top: 4px; }
    mat-dialog-content { min-width: 450px; }
  `]
})
export class DocumentAttachDialogComponent implements OnInit {
  readonly data: DocumentAttachDialogData = inject(MAT_DIALOG_DATA);
  private readonly dialogRef = inject(MatDialogRef<DocumentAttachDialogComponent>);
  private readonly snackBar = inject(MatSnackBar);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly authService = inject(AuthService);

  documents: any[] = [];
  linkedIds: Set<number> = new Set();
  loading = true;
  saving = false;
  uploading = false;

  documentTypes: any[] = [];
  uploadDocType = '';
  uploadDescription = '';
  uploadTitle = '';
  selectedFile: File | null = null;

  ngOnInit(): void {
    this.loadDocuments();
    this.loadDocumentTypes();
  }

  async loadDocumentTypes(): Promise<void> {
    try {
      const res = await fetch('/ords/jit_schema/mcr/v1/documents/types');
      if (res.ok) {
        const data = await res.json();
        this.documentTypes = data?.items ?? [];
      }
    } catch {}
    this.cdr.detectChanges();
  }

  private async loadDocuments(): Promise<void> {
    this.loading = true;
    this.cdr.detectChanges();

    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/documents/mcr/${this.data.mcrId}`);
      if (res.ok) {
        const data = await res.json();
        this.documents = data?.items ?? (Array.isArray(data) ? data : []);
      }
    } catch {
      this.documents = [];
    }

    // Load existing links for this task
    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/documents/links/${this.data.taskId}`);
      if (res.ok) {
        const data = await res.json();
        const links = data?.items ?? (Array.isArray(data) ? data : []);
        this.linkedIds = new Set(links.map((l: any) => l.document_id));
      }
    } catch {
      // No existing links
    }

    this.loading = false;
    this.cdr.detectChanges();
  }

  isLinked(docId: number): boolean {
    return this.linkedIds.has(docId);
  }

  toggleLink(docId: number, checked: boolean): void {
    if (checked) {
      this.linkedIds.add(docId);
    } else {
      this.linkedIds.delete(docId);
    }
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.selectedFile = input.files?.[0] ?? null;
    this.cdr.detectChanges();
  }

  async uploadDocument(): Promise<void> {
    if (!this.uploadDocType || !this.selectedFile) return;
    this.uploading = true;
    this.cdr.detectChanges();

    try {
      const userId = this.authService.getCurrentUserId();
      const payload = {
        user_id: userId,
        title: this.uploadDocType,
        description: this.uploadDescription || null,
        content_type: this.selectedFile.type || 'application/octet-stream'
      };

      const res = await fetch(`/ords/jit_schema/mcr/v1/documents/mcr/${this.data.mcrId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok || res.status === 201) {
        this.snackBar.open('Document uploaded', 'Close', { duration: 3000 });
        this.uploadDocType = '';
        this.uploadDescription = '';
        this.selectedFile = null;
        await this.loadDocuments();
      } else {
        this.snackBar.open('Failed to upload document', 'Close', { duration: 4000 });
      }
    } catch (e: any) {
      this.snackBar.open('Upload error: ' + e.message, 'Close', { duration: 4000 });
    }

    this.uploading = false;
    this.cdr.detectChanges();
  }

  async saveLinks(): Promise<void> {
    this.saving = true;
    this.cdr.detectChanges();

    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/documents/links/${this.data.taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_ids: Array.from(this.linkedIds) })
      });

      if (res.ok) {
        this.snackBar.open('Document links saved', 'Close', { duration: 3000 });
        this.dialogRef.close(true);
      } else {
        this.snackBar.open('Failed to save links', 'Close', { duration: 4000 });
      }
    } catch (e: any) {
      this.snackBar.open('Error: ' + e.message, 'Close', { duration: 4000 });
    }

    this.saving = false;
    this.cdr.detectChanges();
  }
}
