import { Component, inject, ChangeDetectorRef } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { AuthService } from '../../../services/auth.service';

@Component({
  selector: 'app-create-model-dialog',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatSnackBarModule
  ],
  template: `
    <h2 mat-dialog-title>New Model</h2>
    <mat-dialog-content>
      <form [formGroup]="modelForm" class="model-form">
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Change Type</mat-label>
          <mat-select formControlName="change_type">
            @for (ct of changeTypes; track ct.type_id) {
              <mat-option [value]="ct.type_name">{{ ct.type_name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Model Name</mat-label>
          <input matInput formControlName="model_name" placeholder="e.g. Standard Deployment" />
          @if (modelForm.get('model_name')?.hasError('required') && modelForm.get('model_name')?.touched) {
            <mat-error>Model name is required</mat-error>
          }
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Description</mat-label>
          <textarea matInput formControlName="description" rows="3" placeholder="Brief description of this model template"></textarea>
        </mat-form-field>
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-stroked-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="onSave()" [disabled]="saving || modelForm.invalid">
        {{ saving ? 'Saving...' : 'Save' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .model-form {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 360px;
      padding-top: 8px;
    }
    .full-width {
      width: 100%;
    }
  `]
})
export class CreateModelDialogComponent {
  private readonly dialogRef = inject(MatDialogRef<CreateModelDialogComponent>);
  private readonly snackBar = inject(MatSnackBar);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly authService = inject(AuthService);

  saving = false;
  changeTypes: any[] = [];

  modelForm = new FormGroup({
    model_name: new FormControl('', [Validators.required]),
    description: new FormControl(''),
    change_type: new FormControl('MCR')
  });

  constructor() {
    this.loadChangeTypes();
  }

  async loadChangeTypes(): Promise<void> {
    try {
      const res = await fetch('/ords/jit_schema/mcr/v1/workflows/');
      if (res.ok) {
        const data = await res.json();
        this.changeTypes = data?.items ?? (Array.isArray(data) ? data : []);
      } else {
        this.changeTypes = [];
      }
    } catch {
      this.changeTypes = [];
    }
    this.cdr.detectChanges();
  }

  async onSave(): Promise<void> {
    this.modelForm.markAllAsTouched();
    if (this.modelForm.invalid) return;

    this.saving = true;
    this.cdr.detectChanges();

    const val = this.modelForm.value;
    const payload = {
      model_name: val.model_name,
      description: val.description || '',
      change_type: val.change_type || 'MCR',
      created_by: this.authService.getCurrentUserId()
    };

    try {
      const res = await fetch('/ords/jit_schema/mcr/v1/models/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok || res.status === 201) {
        this.snackBar.open('Model created successfully', 'Close', { duration: 3000 });
        this.dialogRef.close(true);
      } else {
        const err = await res.json().catch(() => ({}));
        this.snackBar.open(err.message || 'Failed to create model', 'Close', { duration: 5000 });
        this.saving = false;
      }
    } catch (e: any) {
      this.snackBar.open('Network error: ' + e.message, 'Close', { duration: 5000 });
      this.saving = false;
    }
    this.cdr.detectChanges();
  }
}
