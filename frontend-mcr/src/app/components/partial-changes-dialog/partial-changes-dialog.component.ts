import { Component, inject } from '@angular/core';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';

export interface PartialChangesDialogData {
  changes: any[];
  mcrNumber: string;
}

@Component({
  selector: 'app-partial-changes-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatListModule,
    MatIconModule
  ],
  template: `
    <h2 mat-dialog-title>Partial Changes — {{ data.mcrNumber }}</h2>
    <mat-dialog-content>
      <p class="subtitle">Tasks modified since last approval:</p>
      @if (data.changes && data.changes.length > 0) {
        <mat-list>
          @for (change of data.changes; track change.task_id) {
            <mat-list-item>
              <mat-icon matListItemIcon>edit</mat-icon>
              <span matListItemTitle>{{ change.task_seq }}. {{ change.title }}</span>
              <span matListItemLine>Modified: {{ change.updated_at }}</span>
            </mat-list-item>
          }
        </mat-list>
      } @else {
        <p class="no-changes">No changes recorded.</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="close()">Close</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .subtitle {
      font-size: 14px;
      color: rgba(0, 0, 0, 0.7);
      margin-bottom: 8px;
    }
    .no-changes {
      font-size: 13px;
      color: rgba(0, 0, 0, 0.54);
    }
  `]
})
export class PartialChangesDialogComponent {
  readonly data: PartialChangesDialogData = inject(MAT_DIALOG_DATA);
  private readonly dialogRef = inject(MatDialogRef<PartialChangesDialogComponent>);

  close(): void {
    this.dialogRef.close();
  }
}
