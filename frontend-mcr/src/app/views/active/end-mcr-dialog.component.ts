import { Component, inject } from '@angular/core';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-end-mcr-dialog',
  standalone: true,
  imports: [MatDialogModule, MatFormFieldModule, MatSelectModule, MatInputModule, MatButtonModule, FormsModule],
  template: `
    <h2 mat-dialog-title>Closure Action</h2>
    <mat-dialog-content>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Closure Status</mat-label>
        <mat-select [(ngModel)]="selectedAction">
          <mat-option value="partial_complete">Partial Complete</mat-option>
          <mat-option value="cancelled">Cancelled</mat-option>
          <mat-option value="failed">Failed</mat-option>
        </mat-select>
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Closure Notes</mat-label>
        <textarea matInput [(ngModel)]="closureNotes" rows="4"
                  placeholder="Enter any closure notes..."></textarea>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-stroked-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" [disabled]="!selectedAction" (click)="onConfirm()">OK</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .full-width { width: 100%; }
    mat-dialog-content { min-width: 400px; display: flex; flex-direction: column; gap: 12px; padding-top: 12px; }
  `]
})
export class EndMCRDialogComponent {
  private readonly dialogRef = inject(MatDialogRef<EndMCRDialogComponent>);
  selectedAction = '';
  closureNotes = '';

  onConfirm(): void {
    this.dialogRef.close({ action: this.selectedAction, notes: this.closureNotes });
  }
}
