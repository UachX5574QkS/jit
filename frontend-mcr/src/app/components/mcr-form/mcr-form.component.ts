import {
  Component,
  EventEmitter,
  inject,
  Input,
  OnInit,
  Output,
  ViewChild,
  ChangeDetectorRef
} from '@angular/core';
import {
  AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators
} from '@angular/forms';
import { Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatNativeDateModule } from '@angular/material/core';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import {
  RACIAssignmentComponent,
  User,
  Department,
  Team
} from '../raci-assignment/raci-assignment.component';

import { MCRService } from '../../services/mcr.service';
import { UserService } from '../../services/user.service';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-mcr-form',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatDatepickerModule,
    MatNativeDateModule,
    MatButtonModule,
    MatSnackBarModule,
    RACIAssignmentComponent
  ],
  templateUrl: './mcr-form.component.html',
  styleUrl: './mcr-form.component.scss'
})
export class MCRFormComponent implements OnInit {
  @Input() editMcrId: number | null = null;
  @Output() cancel = new EventEmitter<void>();
  @Output() created = new EventEmitter<any>();
  @ViewChild(RACIAssignmentComponent) raciComponent!: RACIAssignmentComponent;

  private readonly mcrService = inject(MCRService);
  private readonly userService = inject(UserService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly router = inject(Router);
  private readonly authService = inject(AuthService);
  private readonly cdr = inject(ChangeDetectorRef);

  users: User[] = [];
  departments: Department[] = [];
  teams: Team[] = [];
  raciValid = false;
  submitted = false;

  mcrForm = new FormGroup(
    {
      mcrNumber: new FormControl('', [Validators.required]),
      ownerUserId: new FormControl<number | null>(null, [Validators.required]),
      description: new FormControl('', [Validators.required]),
      startDate: new FormControl<Date | null>(null, [Validators.required]),
      endDate: new FormControl<Date | null>(null, [Validators.required])
    },
    { validators: [this.dateRangeValidator] }
  );

  get formTitle(): string {
    return this.editMcrId ? 'Update MCR' : 'Create MCR';
  }

  ngOnInit(): void {
    this.userService.getUsers().subscribe({
      next: (users) => {
        this.users = users;
      },
      error: () => {
        this.users = [];
      }
    });
    this.userService.getDepartments().subscribe({
      next: (depts) => {
        this.departments = depts;
      },
      error: () => {
        this.departments = [];
      }
    });
    this.userService.getTeams().subscribe({
      next: (teams) => {
        this.teams = teams;
      },
      error: () => {
        this.teams = [];
      }
    });

    if (this.editMcrId) {
      this.loadMCRForEdit();
    }
  }

  async loadMCRForEdit(): Promise<void> {
    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/requests/${this.editMcrId}`);
      if (res.ok) {
        const mcr = await res.json();
        this.mcrForm.patchValue({
          mcrNumber: mcr.mcr_number,
          ownerUserId: mcr.owner_user_id,
          description: mcr.description,
          startDate: mcr.estimated_start_date ? new Date(mcr.estimated_start_date) : null,
          endDate: mcr.estimated_end_date ? new Date(mcr.estimated_end_date) : null
        });
        this.cdr.detectChanges();
      }
    } catch { /* ignore */ }
  }

  dateRangeValidator(group: AbstractControl): ValidationErrors | null {
    const start = group.get('startDate')?.value;
    const end = group.get('endDate')?.value;
    if (start && end && end < start) {
      return { dateRange: true };
    }
    return null;
  }

  onRaciChange(): void {
    if (this.raciComponent) {
      this.raciValid = this.raciComponent.validate();
    }
  }

  async onSave(): Promise<void> {
    this.submitted = true;
    this.mcrForm.markAllAsTouched();

    const raciIsValid = this.raciComponent?.validate() ?? false;
    this.raciValid = raciIsValid;

    if (this.mcrForm.invalid || !raciIsValid) {
      return;
    }

    const formValue = this.mcrForm.value;
    const formatDate = (d: Date | null | undefined) => {
      if (!d) return null;
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    const payload = {
      mcr_number: formValue.mcrNumber,
      owner_user_id: formValue.ownerUserId,
      description: formValue.description,
      start_date: formatDate(formValue.startDate),
      end_date: formatDate(formValue.endDate),
      raci: JSON.stringify(this.raciComponent.getRACIEntries()),
      user_id: this.authService.getCurrentUserId()
    };

    if (this.editMcrId) {
      // Update existing MCR
      try {
        const res = await fetch(`/ords/jit_schema/mcr/v1/requests/${this.editMcrId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          this.snackBar.open('MCR updated successfully', 'Close', { duration: 3000 });
          this.router.navigate(['/active']);
        } else {
          const err = await res.json().catch(() => null);
          const message = err?.error || err?.message || 'Failed to update MCR. Please try again.';
          this.snackBar.open(message, 'Close', { duration: 10000 });
        }
      } catch {
        this.snackBar.open('Failed to update MCR. Please try again.', 'Close', { duration: 10000 });
      }
    } else {
      // Create new MCR
      this.mcrService.createMCR(payload).subscribe({
        next: (result) => {
          this.snackBar.open('MCR created successfully', 'Close', {
            duration: 3000
          });
          this.created.emit(result);
          this.router.navigate(['/active']);
        },
        error: (err) => {
          const message =
            err.error?.error || err.error?.message || err.message || JSON.stringify(err.error) || 'Failed to create MCR. Please try again.';
          this.snackBar.open(message, 'Close', { duration: 10000 });
        }
      });
    }
  }

  onCancel(): void {
    this.router.navigate(['/active']);
  }
}
