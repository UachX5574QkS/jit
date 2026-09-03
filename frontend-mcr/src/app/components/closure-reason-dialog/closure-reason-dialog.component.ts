import { Component, inject } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';

export interface ClosureReasonDialogData {
  action: string; // 'Failed' or 'Cancelled'
}

@Component({
  selector: 'app-closure-reason-dialog',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule
  ],
  template: `
    <h2 mat-dialog-title>Reason for {{ data.action }}</h2>
    <mat-dialog-content>
      <form [formGroup]="form" class="reason-form">
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Reason</mat-label>
          <textarea matInput formControlName="reason" rows="5"
                    placeholder="Please provide a reason for this action..."></textarea>
          @if (form.get('reason')?.hasError('required') && form.get('reason')?.touched) {
            <mat-error>Reason is required</mat-error>
          }
          @if (form.get('reason')?.hasError('maxlength')) {
            <mat-error>Reason must not exceed 1000 characters</mat-error>
          }
          <mat-hint align="end">{{ form.get('reason')?.value?.length || 0 }} / 1000</mat-hint>
        </mat-form-field>
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-flat-button color="primary" (click)="onSave()" [disabled]="form.invalid">Save</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .reason-form {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 400px;
    }
    .full-width {
      width: 100%;
    }
  `]
})
export class ClosureReasonDialogComponent {
  private readonly fb = inject(FormBuilder);
  private readonly dialogRef = inject(MatDialogRef<ClosureReasonDialogComponent>);
  readonly data: ClosureReasonDialogData = inject(MAT_DIALOG_DATA);

  readonly form: FormGroup = this.fb.group({
    reason: ['', [Validators.required, Validators.maxLength(1000)]]
  });

  onCancel(): void {
    this.dialogRef.close(undefined);
  }

  onSave(): void {
    if (this.form.valid) {
      this.dialogRef.close(this.form.value.reason);
    }
  }
}
