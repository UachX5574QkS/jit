import { Component, OnInit, inject } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { DocumentService } from '../../services/document.service';

export interface DocumentLinkerData {
  mcrId: number;
  taskId: number;
}

@Component({
  selector: 'app-document-linker',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatCheckboxModule,
    MatIconModule,
    MatDividerModule,
    MatProgressSpinnerModule
  ],
  template: `
    <h2 mat-dialog-title>Task Documents</h2>
    <mat-dialog-content>
      @if (loading) {
        <div class="loading-container">
          <mat-spinner diameter="36"></mat-spinner>
        </div>
      } @else {
        <!-- Existing documents with checkboxes -->
        <div class="documents-list">
          <label class="section-label">MCR Documents</label>
          @if (documents.length === 0) {
            <p class="hint-text">No documents uploaded yet.</p>
          }
          @for (doc of documents; track doc.document_id) {
            <mat-checkbox
              [checked]="isLinked(doc.document_id)"
              (change)="toggleLink(doc.document_id, $event.checked)">
              {{ doc.title }}
            </mat-checkbox>
          }
        </div>

        <mat-divider></mat-divider>

        <!-- Upload new document -->
        <div class="upload-section">
          <label class="section-label">Upload New Document</label>
          <form [formGroup]="uploadForm" class="upload-form">
            <mat-form-field appearance="outline" class="full-width">
              <mat-label>Document Title</mat-label>
              <input matInput formControlName="title" maxlength="255" />
              @if (uploadForm.get('title')?.hasError('required') && uploadForm.get('title')?.touched) {
                <mat-error>Title is required</mat-error>
              }
              @if (uploadForm.get('title')?.hasError('maxlength')) {
                <mat-error>Title must be 255 characters or fewer</mat-error>
              }
              <mat-hint>{{ uploadForm.get('title')?.value?.length || 0 }} / 255</mat-hint>
            </mat-form-field>

            <div class="file-input-row">
              <button mat-stroked-button type="button" (click)="fileInput.click()">
                <mat-icon>upload_file</mat-icon> Choose File
              </button>
              <span class="file-name">{{ selectedFile?.name || 'No file selected' }}</span>
              <input #fileInput type="file" hidden (change)="onFileSelected($event)" />
            </div>

            <button mat-flat-button color="primary" type="button"
                    (click)="uploadDocument()"
                    [disabled]="uploadForm.invalid || !selectedFile || uploading">
              @if (uploading) {
                <mat-spinner diameter="18" class="inline-spinner"></mat-spinner>
              } @else {
                Upload
              }
            </button>
          </form>
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-flat-button color="primary" (click)="onSave()" [disabled]="saving">Save Links</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .loading-container {
      display: flex;
      justify-content: center;
      padding: 24px;
    }
    .documents-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 400px;
    }
    .section-label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 8px;
      color: rgba(0, 0, 0, 0.7);
    }
    .hint-text {
      font-size: 13px;
      color: rgba(0, 0, 0, 0.54);
    }
    .upload-section {
      padding-top: 16px;
    }
    .upload-form {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .full-width {
      width: 100%;
    }
    .file-input-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .file-name {
      font-size: 13px;
      color: rgba(0, 0, 0, 0.6);
    }
    .inline-spinner {
      display: inline-block;
    }
    mat-divider {
      margin: 16px 0;
    }
  `]
})
export class DocumentLinkerComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly dialogRef = inject(MatDialogRef<DocumentLinkerComponent>);
  private readonly data: DocumentLinkerData = inject(MAT_DIALOG_DATA);
  private readonly documentService = inject(DocumentService);

  documents: any[] = [];
  linkedDocIds: Set<number> = new Set();
  selectedFile: File | null = null;
  loading = true;
  uploading = false;
  saving = false;

  readonly uploadForm: FormGroup = this.fb.group({
    title: ['', [Validators.required, Validators.maxLength(255)]]
  });

  ngOnInit(): void {
    this.loadData();
  }

  private loadData(): void {
    this.loading = true;

    // Load all MCR documents
    this.documentService.getMCRDocuments(this.data.mcrId).subscribe({
      next: (docs) => {
        this.documents = docs ?? [];
        // Load task-specific links
        this.documentService.getTaskDocuments(this.data.taskId).subscribe({
          next: (links) => {
            this.linkedDocIds = new Set(
              (links ?? []).map((l: any) => l.document_id)
            );
            this.loading = false;
          },
          error: () => {
            this.loading = false;
          }
        });
      },
      error: () => {
        this.loading = false;
      }
    });
  }

  isLinked(documentId: number): boolean {
    return this.linkedDocIds.has(documentId);
  }

  toggleLink(documentId: number, checked: boolean): void {
    if (checked) {
      this.linkedDocIds.add(documentId);
    } else {
      this.linkedDocIds.delete(documentId);
    }
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.selectedFile = input.files[0];
    }
  }

  uploadDocument(): void {
    if (this.uploadForm.invalid || !this.selectedFile) return;

    this.uploading = true;
    const formData = new FormData();
    formData.append('title', this.uploadForm.get('title')!.value.trim());
    formData.append('file', this.selectedFile);

    this.documentService.uploadDocument(this.data.mcrId, formData).subscribe({
      next: (newDoc) => {
        this.documents.push(newDoc);
        this.linkedDocIds.add(newDoc.document_id);
        this.uploadForm.reset();
        this.selectedFile = null;
        this.uploading = false;
      },
      error: () => {
        this.uploading = false;
      }
    });
  }

  onSave(): void {
    this.saving = true;
    const documentIds = Array.from(this.linkedDocIds);
    this.documentService.updateTaskLinks(this.data.taskId, documentIds).subscribe({
      next: () => {
        this.saving = false;
        this.dialogRef.close(true);
      },
      error: () => {
        this.saving = false;
      }
    });
  }

  onCancel(): void {
    this.dialogRef.close(null);
  }
}
