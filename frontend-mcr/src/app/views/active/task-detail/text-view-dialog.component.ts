import { Component, inject } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';

@Component({
  selector: 'app-text-view-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      <pre class="text-content">{{ data.content }}</pre>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-raised-button color="primary" mat-dialog-close>Close</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .text-content {
      white-space: pre-wrap;
      font-family: 'Segoe UI', system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.6;
      margin: 0;
      padding: 8px;
      background: var(--color-bg-muted, #F8F7FA);
      border-radius: 8px;
    }
  `]
})
export class TextViewDialogComponent {
  readonly data: { title: string; content: string } = inject(MAT_DIALOG_DATA);
}
