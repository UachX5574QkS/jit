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
  models: any[] = [];
  changeTypes: any[] = [];
  selectedModelId: number | null = null;
  raciValid = false;
  submitted = false;
  mcrStatus: string = '';
  responsibleNames: string[] = [];

  mcrForm = new FormGroup(
    {
      mcrNumber: new FormControl('', [Validators.required]),
      changeType: new FormControl('MCR'),
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

  get filteredModels(): any[] {
    const selectedType = this.mcrForm.get('changeType')?.value || 'MCR';
    return this.models.filter(m => (m.change_type || 'MCR') === selectedType);
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
    } else {
      this.loadModels();
    }

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

  async loadModels(): Promise<void> {
    try {
      const res = await fetch('/ords/jit_schema/mcr/v1/models/');
      if (res.ok) {
        const data = await res.json();
        this.models = data?.items ?? (Array.isArray(data) ? data : []);
      } else {
        this.models = [];
      }
    } catch {
      this.models = [];
    }
    this.cdr.detectChanges();
  }

  async loadMCRForEdit(): Promise<void> {
    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/requests/${this.editMcrId}`);
      if (res.ok) {
        const mcr = await res.json();
        this.mcrStatus = mcr.mcr_status || '';
        this.mcrForm.patchValue({
          mcrNumber: mcr.mcr_number,
          ownerUserId: mcr.owner_user_id,
          description: mcr.description,
          startDate: mcr.estimated_start_date ? new Date(mcr.estimated_start_date) : null,
          endDate: mcr.estimated_end_date ? new Date(mcr.estimated_end_date) : null
        });

        // Populate RACI component with existing data
        if (mcr.raci && Array.isArray(mcr.raci) && this.raciComponent) {
          this.populateRaci(mcr.raci);
        } else if (mcr.raci && Array.isArray(mcr.raci)) {
          // Component may not be ready yet — defer
          setTimeout(() => this.populateRaci(mcr.raci), 200);
        }

        this.cdr.detectChanges();
      }
    } catch { /* ignore */ }
  }

  private populateRaci(raciEntries: any[]): void {
    if (!this.raciComponent) return;
    this.raciComponent.accountableIds = raciEntries
      .filter(r => r.raci_role === 'Accountable')
      .map(r => r.user_id);
    this.raciComponent.coordinatorIds = raciEntries
      .filter(r => r.raci_role === 'Coordinator' || r.raci_role === 'Responsible')
      .map(r => r.user_id);
    this.raciComponent.informedIds = raciEntries
      .filter(r => r.raci_role === 'Informed')
      .map(r => r.user_id);
    this.cdr.detectChanges();

    // Load responsible names from tasks
    if (this.editMcrId) {
      this.loadResponsibleFromTasks();
    }
  }

  private async loadResponsibleFromTasks(): Promise<void> {
    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/tasks/mcr/${this.editMcrId}`);
      if (res.ok) {
        const data = await res.json();
        const tasks = data?.items ?? [];
        const implIds = new Set<number>();
        tasks.forEach((t: any) => {
          if (t.implementor_id && t.implementor_type === 'USER') {
            implIds.add(t.implementor_id);
          }
        });
        // Map IDs to names
        this.responsibleNames = [...implIds].map(id => {
          const user = this.users.find(u => u.user_id === id);
          return user?.display_name ?? `User #${id}`;
        });
        if (this.raciComponent) {
          this.raciComponent.responsibleNames = this.responsibleNames;
        }
        this.cdr.detectChanges();
      }
    } catch { /* silent */ }
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

    if (this.mcrForm.invalid) {
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
      change_type: formValue.changeType,
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
      try {
        const res = await fetch('/ords/jit_schema/mcr/v1/requests/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (res.ok || res.status === 201) {
          const result = await res.json().catch(() => ({}));
          this.created.emit(result);

          if (this.selectedModelId && result.mcr_id) {
            await this.copyModelTasks(result.mcr_id);
          } else {
            this.snackBar.open('MCR created successfully', 'Close', { duration: 3000 });
            this.router.navigate(['/active']);
          }
        } else {
          const err = await res.json().catch(() => null);
          const message = err?.error || err?.message || 'Failed to create MCR. Please try again.';
          this.snackBar.open(message, 'Close', { duration: 10000 });
        }
      } catch {
        this.snackBar.open('Failed to create MCR. Please try again.', 'Close', { duration: 10000 });
      }
      this.cdr.detectChanges();
    }
  }

  async copyModelTasks(mcrId: number): Promise<void> {
    try {
      const modelRes = await fetch(`/ords/jit_schema/mcr/v1/models/${this.selectedModelId}`);
      if (!modelRes.ok) {
        this.snackBar.open('MCR created, but failed to load model tasks', 'Close', { duration: 5000 });
        this.router.navigate(['/active', mcrId]);
        this.cdr.detectChanges();
        return;
      }

      const modelData = await modelRes.json();
      const modelTasks = modelData?.tasks ?? modelData?.items ?? [];

      if (modelTasks.length === 0) {
        this.snackBar.open('MCR created (model has no tasks)', 'Close', { duration: 3000 });
        this.router.navigate(['/active', mcrId]);
        this.cdr.detectChanges();
        return;
      }

      // Sort by task_seq to maintain order
      modelTasks.sort((a: any, b: any) => (a.task_seq ?? 0) - (b.task_seq ?? 0));

      const userId = this.authService.getCurrentUserId();
      const seqToTaskId: Map<number, number> = new Map();
      let createdCount = 0;

      // Create tasks in sequence order
      for (const mt of modelTasks) {
        const taskPayload: any = {
          user_id: userId,
          title: mt.title,
          description: mt.description || null,
          owner_dept_id: mt.owner_dept_id || null,
          implementor_id: mt.implementor_id || null,
          implementor_type: mt.implementor_type || null,
          benefits: mt.benefits || null,
          sub_actions: mt.sub_actions || null,
          backout_plan: mt.backout_plan || null,
          estimated_duration_mins: mt.estimated_duration_mins || null,
          soft_deps_csv: '',
          hard_deps_csv: ''
        };

        // Map dependency seqs to actual task_ids if earlier tasks have been created
        if (mt.soft_dep_seqs) {
          const softSeqs = String(mt.soft_dep_seqs).split(',').map((s: string) => Number(s.trim())).filter((n: number) => !isNaN(n) && n > 0);
          const mappedSoft = softSeqs.map((seq: number) => seqToTaskId.get(seq)).filter((id: number | undefined) => id != null);
          taskPayload.soft_deps_csv = mappedSoft.join(',');
        }
        if (mt.hard_dep_seqs) {
          const hardSeqs = String(mt.hard_dep_seqs).split(',').map((s: string) => Number(s.trim())).filter((n: number) => !isNaN(n) && n > 0);
          const mappedHard = hardSeqs.map((seq: number) => seqToTaskId.get(seq)).filter((id: number | undefined) => id != null);
          taskPayload.hard_deps_csv = mappedHard.join(',');
        }

        try {
          const taskRes = await fetch(`/ords/jit_schema/mcr/v1/tasks/mcr/${mcrId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(taskPayload)
          });

          if (taskRes.ok || taskRes.status === 201) {
            const taskResult = await taskRes.json().catch(() => ({}));
            if (taskResult.task_id && mt.task_seq) {
              seqToTaskId.set(mt.task_seq, taskResult.task_id);
            }
            createdCount++;
          }
        } catch {
          // Continue with remaining tasks even if one fails
        }
      }

      this.snackBar.open(`MCR created with ${createdCount} task${createdCount !== 1 ? 's' : ''} from model`, 'Close', { duration: 5000 });
      this.router.navigate(['/active', mcrId]);
    } catch {
      this.snackBar.open('MCR created, but error copying model tasks', 'Close', { duration: 5000 });
      this.router.navigate(['/active', mcrId]);
    }
    this.cdr.detectChanges();
  }

  onCancel(): void {
    this.router.navigate(['/active']);
  }

  get canCancelMCR(): boolean {
    return !!this.editMcrId && ['Draft', 'Ready', 'Approved'].includes(this.mcrStatus);
  }

  async onCancelMCR(): Promise<void> {
    const confirmed = confirm('Are you sure you want to cancel this MCR? This cannot be undone.');
    if (!confirmed) {
      return;
    }

    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/requests/${this.editMcrId}/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'cancel',
          user_id: this.authService.getCurrentUserId()
        })
      });

      if (res.ok) {
        this.snackBar.open('MCR cancelled', 'Close', { duration: 3000 });
        this.router.navigate(['/active']);
      } else {
        const err = await res.json().catch(() => null);
        const message = err?.error || err?.message || 'Failed to cancel MCR. Please try again.';
        this.snackBar.open(message, 'Close', { duration: 10000 });
      }
    } catch {
      this.snackBar.open('Failed to cancel MCR. Please try again.', 'Close', { duration: 10000 });
    }
    this.cdr.detectChanges();
  }
}
