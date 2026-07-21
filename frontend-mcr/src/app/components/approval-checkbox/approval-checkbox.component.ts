import { Component, Input, Output, EventEmitter, inject } from '@angular/core';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MCRService } from '../../services/mcr.service';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-approval-checkbox',
  standalone: true,
  imports: [
    MatCheckboxModule,
    MatSnackBarModule
  ],
  template: `
    @if (isVisible()) {
      <mat-checkbox
        [checked]="mcr.mcr_status === 'Approved'"
        [disabled]="mcr.mcr_status === 'Approved'"
        (change)="onApprove($event.checked)"
        aria-label="Approve MCR">
      </mat-checkbox>
    } @else if (mcr.mcr_status === 'Approved' || mcr.approved_by_user_id) {
      <mat-checkbox [checked]="true" [disabled]="true" aria-label="Approved"></mat-checkbox>
    }
  `,
  styles: [`
    :host {
      display: inline-block;
    }
  `]
})
export class ApprovalCheckboxComponent {
  @Input({ required: true }) mcr!: any;
  @Output() approved = new EventEmitter<void>();

  private readonly mcrService = inject(MCRService);
  private readonly authService = inject(AuthService);
  private readonly snackBar = inject(MatSnackBar);

  /**
   * Approval checkbox is visible only when:
   * - MCR status is 'Pending' AND
   * - Current user is in the Management Group (Responsible or Accountable in RACI)
   */
  isVisible(): boolean {
    if (this.mcr.mcr_status !== 'Pending') return false;
    return this.isManagementGroup();
  }

  private isManagementGroup(): boolean {
    const userId = this.authService.getCurrentUserId();
    if (!userId) return false;

    // Check if user is in the RACI as Responsible or Accountable
    const raci = this.mcr.raci ?? [];
    return raci.some((r: any) =>
      r.user_id === userId &&
      (r.raci_role === 'Responsible' || r.raci_role === 'Accountable')
    );
  }

  onApprove(checked: boolean): void {
    if (!checked) return;

    this.mcrService.approveMCR(this.mcr.mcr_id).subscribe({
      next: () => {
        this.snackBar.open('MCR approved successfully', 'Close', { duration: 3000 });
        this.approved.emit();
      },
      error: (err) => {
        const msg = err.error?.message || 'Approval failed — prerequisites not met';
        this.snackBar.open(msg, 'Close', { duration: 5000 });
      }
    });
  }
}
