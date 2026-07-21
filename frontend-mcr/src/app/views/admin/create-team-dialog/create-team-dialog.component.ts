import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { AuthService } from '../../../services/auth.service';

@Component({
  selector: 'app-create-team-dialog',
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
    <h2 mat-dialog-title>New Team</h2>
    <mat-dialog-content>
      <form [formGroup]="teamForm" class="team-form">
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Team Name</mat-label>
          <input matInput formControlName="teamName" placeholder="e.g. Infrastructure" />
          @if (teamForm.get('teamName')?.hasError('required') && teamForm.get('teamName')?.touched) {
            <mat-error>Team name is required</mat-error>
          }
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Description</mat-label>
          <textarea matInput formControlName="description" rows="3" placeholder="Team description"></textarea>
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Members</mat-label>
          <mat-select multiple formControlName="memberIds" aria-label="Select team members">
            @for (user of users; track user.user_id) {
              <mat-option [value]="user.user_id">{{ user.display_name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-stroked-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="onSave()" [disabled]="saving || teamForm.invalid">
        {{ saving ? 'Saving...' : 'Save' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .team-form {
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
export class CreateTeamDialogComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<CreateTeamDialogComponent>);
  private readonly snackBar = inject(MatSnackBar);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly authService = inject(AuthService);

  users: any[] = [];
  saving = false;

  teamForm = new FormGroup({
    teamName: new FormControl('', [Validators.required]),
    description: new FormControl(''),
    memberIds: new FormControl<number[]>([])
  });

  ngOnInit(): void {
    this.loadUsers();
  }

  async loadUsers(): Promise<void> {
    try {
      const res = await fetch('/ords/jit_schema/mcr/v1/users/');
      if (res.ok) {
        const data = await res.json();
        this.users = data?.items ?? (Array.isArray(data) ? data : []);
      }
    } catch {
      this.users = [];
    }
    this.cdr.detectChanges();
  }

  async onSave(): Promise<void> {
    this.teamForm.markAllAsTouched();
    if (this.teamForm.invalid) return;

    this.saving = true;
    this.cdr.detectChanges();

    const val = this.teamForm.value;
    const userId = this.authService.getCurrentUserId();
    const payload = {
      user_id: userId,
      team_name: val.teamName,
      description: val.description || '',
      member_ids: (val.memberIds ?? []).join(',')
    };

    try {
      const res = await fetch('/ords/jit_schema/mcr/v1/users/teams/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok || res.status === 201) {
        this.snackBar.open('Team created successfully', 'Close', { duration: 3000 });
        this.dialogRef.close(true);
      } else {
        const err = await res.json().catch(() => ({}));
        this.snackBar.open(err.message || 'Failed to create team', 'Close', { duration: 5000 });
        this.saving = false;
      }
    } catch (e: any) {
      this.snackBar.open('Network error: ' + e.message, 'Close', { duration: 5000 });
      this.saving = false;
    }
    this.cdr.detectChanges();
  }
}
