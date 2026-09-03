import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MatDialog, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { AuthService } from '../../../services/auth.service';
import { DocumentAttachDialogComponent, DocumentAttachDialogData } from './document-attach-dialog.component';

export interface AddTaskDialogData {
  mcrId: number;
}

@Component({
  selector: 'app-add-task-dialog',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatCheckboxModule,
    MatSnackBarModule
  ],
  template: `
    <h2 mat-dialog-title>Add Task</h2>
    <mat-dialog-content>
      <form [formGroup]="form" class="task-form">
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Title</mat-label>
          <input matInput formControlName="title" placeholder="Task title" />
          @if (form.get('title')?.hasError('required') && form.get('title')?.touched) {
            <mat-error>Title is required</mat-error>
          }
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Description</mat-label>
          <textarea matInput formControlName="description" rows="3" placeholder="Describe the task"></textarea>
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Jira Reference</mat-label>
          <input matInput formControlName="jira_reference" placeholder="e.g. PROJ-123" />
        </mat-form-field>

        <div class="form-row">
          <mat-form-field appearance="outline">
            <mat-label>Owner Department</mat-label>
            <mat-select formControlName="owner_dept_id">
              @for (dept of departments; track dept.department_id) {
                <mat-option [value]="dept.department_id">{{ dept.department_name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Actioned By</mat-label>
          <mat-select formControlName="actioned_by">
            <mat-optgroup label="Departments">
              @for (dept of departments; track dept.department_id) {
                <mat-option [value]="'DEPT:' + dept.department_id">{{ dept.department_name }}</mat-option>
              }
            </mat-optgroup>
            <mat-optgroup label="Teams">
              @for (team of teams; track team.team_id) {
                <mat-option [value]="'TEAM:' + team.team_id">{{ team.team_name }}</mat-option>
              }
            </mat-optgroup>
            <mat-optgroup label="Individuals">
              @for (user of users; track user.user_id) {
                <mat-option [value]="'USER:' + user.user_id">{{ user.display_name }}</mat-option>
              }
            </mat-optgroup>
          </mat-select>
        </mat-form-field>

        <div class="form-row">
          <mat-form-field appearance="outline">
            <mat-label>Estimated Start Date</mat-label>
            <mat-select formControlName="start_date">
              @for (date of dateOptions; track date) {
                <mat-option [value]="date">{{ formatDateOption(date) }}</mat-option>
              }
            </mat-select>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Start Time</mat-label>
            <input matInput type="time" formControlName="start_time" />
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Duration (minutes)</mat-label>
            <input matInput type="number" formControlName="estimated_duration_mins" min="1" />
          </mat-form-field>
        </div>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Benefits</mat-label>
          <textarea matInput formControlName="benefits" rows="2" placeholder="What benefits does this task deliver?"></textarea>
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Dependency (Any Status)</mat-label>
          <mat-select multiple formControlName="soft_dependencies">
            @for (t of otherTasks; track t.task_id) {
              <mat-option [value]="t.task_id">{{ t.task_seq }}. {{ t.title }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Dependency (Must Succeed)</mat-label>
          <mat-select multiple formControlName="hard_dependencies">
            @for (t of otherTasks; track t.task_id) {
              <mat-option [value]="t.task_id">{{ t.task_seq }}. {{ t.title }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      </form>

      <!-- Sub-Actions Section -->
      <div class="section-divider">
        <h4 class="section-title">Sub-Actions / Steps</h4>
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Steps to complete this task</mat-label>
          <textarea matInput [formControl]="subActionsControl" rows="5"
                    placeholder="List the steps needed to complete this task..."></textarea>
        </mat-form-field>
      </div>

      <!-- Backout Plan Section -->
      <div class="section-divider">
        <h4 class="section-title">Backout Plan</h4>
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Backout / Rollback Steps</mat-label>
          <textarea matInput [formControl]="backoutPlanControl" rows="4"
                    placeholder="Describe how to reverse this change if needed..."></textarea>
        </mat-form-field>
      </div>

      <!-- Documents Section -->
      <div class="section-divider">
        <h4 class="section-title">Documents</h4>
        <mat-checkbox [formControl]="attachDocsControl">Attach documents after save</mat-checkbox>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-stroked-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="onSave()" [disabled]="saving || form.invalid">
        {{ saving ? 'Saving...' : 'Save' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .task-form {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 450px;
      padding-top: 8px;
    }
    .full-width { width: 100%; }
    .form-row {
      display: flex;
      gap: 16px;
    }
    .form-row mat-form-field { flex: 1; }
    .section-divider {
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid var(--color-line, #E8E4EE);
    }
    .section-title {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--color-nw-purple, #5A287D);
      margin: 0 0 12px;
    }
  `]
})
export class AddTaskDialogComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<AddTaskDialogComponent>);
  private readonly data: AddTaskDialogData = inject(MAT_DIALOG_DATA);
  private readonly authService = inject(AuthService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly dialog = inject(MatDialog);

  departments: any[] = [];
  teams: any[] = [];
  users: any[] = [];
  otherTasks: any[] = [];
  saving = false;
  mcrStartDate = '';
  mcrEndDate = '';
  dateOptions: string[] = [];

  subActionsControl = new FormControl('');
  backoutPlanControl = new FormControl('');
  attachDocsControl = new FormControl(false);

  form = new FormGroup({
    title: new FormControl('', [Validators.required]),
    description: new FormControl(''),
    jira_reference: new FormControl(''),
    estimated_duration_mins: new FormControl<number | null>(null),
    owner_dept_id: new FormControl<number | null>(null),
    benefits: new FormControl(''),
    actioned_by: new FormControl<string | null>(null),
    start_date: new FormControl(''),
    start_time: new FormControl(''),
    soft_dependencies: new FormControl<number[]>([]),
    hard_dependencies: new FormControl<number[]>([])
  });

  ngOnInit(): void {
    this.loadDepartments();
    this.loadTeams();
    this.loadUsers();
    this.loadOtherTasks();
    this.loadMcrDates();
  }

  async loadMcrDates(): Promise<void> {
    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/requests/${this.data.mcrId}`);
      if (res.ok) {
        const mcr = await res.json();
        this.mcrStartDate = mcr.estimated_start_date;
        this.mcrEndDate = mcr.estimated_end_date;
        this.dateOptions = this.generateDateOptions(this.mcrStartDate, this.mcrEndDate);
        this.cdr.detectChanges();
      }
    } catch {}
  }

  generateDateOptions(start: string, end: string): string[] {
    if (!start || !end) return [];
    const options: string[] = [];
    const startDate = new Date(start);
    const endDate = new Date(end);
    const current = new Date(startDate);
    while (current <= endDate) {
      const y = current.getFullYear();
      const m = String(current.getMonth() + 1).padStart(2, '0');
      const d = String(current.getDate()).padStart(2, '0');
      options.push(`${y}-${m}-${d}`);
      current.setDate(current.getDate() + 1);
    }
    return options;
  }

  formatDateOption(dateStr: string): string {
    const parts = dateStr.split('-');
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }

  async loadDepartments(): Promise<void> {
    try {
      const res = await fetch('/ords/jit_schema/mcr/v1/users/departments');
      const data = await res.json();
      this.departments = data?.items ?? [];
      this.cdr.detectChanges();
    } catch {
      this.departments = [];
    }
  }

  async loadTeams(): Promise<void> {
    try {
      const res = await fetch('/ords/jit_schema/mcr/v1/users/teams');
      const data = await res.json();
      this.teams = data?.items ?? [];
      this.cdr.detectChanges();
    } catch {
      this.teams = [];
    }
  }

  async loadUsers(): Promise<void> {
    try {
      const res = await fetch('/ords/jit_schema/mcr/v1/users/');
      const data = await res.json();
      this.users = data?.items ?? [];
      this.cdr.detectChanges();
    } catch {
      this.users = [];
    }
  }

  async loadOtherTasks(): Promise<void> {
    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/tasks/mcr/${this.data.mcrId}`);
      if (res.ok) {
        const data = await res.json();
        this.otherTasks = data?.items ?? (Array.isArray(data) ? data : []);
      }
    } catch {
      this.otherTasks = [];
    }
    this.cdr.detectChanges();
  }

  async onSave(): Promise<void> {
    if (this.form.invalid) return;
    this.saving = true;

    const userId = this.authService.getCurrentUserId();

    // Parse actioned_by into implementor_type and implementor_id
    let implementor_type: string | null = null;
    let implementor_id: number | null = null;
    const actionedBy = this.form.value.actioned_by;
    if (actionedBy) {
      const [type, id] = actionedBy.split(':');
      implementor_id = Number(id);
      if (type === 'DEPT') implementor_type = 'DEPARTMENT';
      else if (type === 'TEAM') implementor_type = 'TEAM';
      else if (type === 'USER') implementor_type = 'USER';
    } else {
      // Default to current user
      implementor_id = userId;
      implementor_type = 'USER';
    }

    const payload = {
      user_id: userId,
      title: this.form.value.title,
      description: this.form.value.description || null,
      jira_reference: this.form.value.jira_reference || null,
      estimated_duration_mins: this.form.value.estimated_duration_mins || null,
      owner_dept_id: this.form.value.owner_dept_id || null,
      implementor_id,
      implementor_type,
      benefits: this.form.value.benefits || null,
      start_date: this.form.value.start_date || null,
      start_time: this.form.value.start_time || null,
      soft_deps_csv: (this.form.value.soft_dependencies ?? []).join(','),
      hard_deps_csv: (this.form.value.hard_dependencies ?? []).join(','),
      sub_actions: this.subActionsControl.value || null,
      backout_plan: this.backoutPlanControl.value || null
    };

    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/tasks/mcr/${this.data.mcrId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok || res.status === 201) {
        const result = await res.json().catch(() => ({}));
        const newTaskId = result.task_id;

        this.snackBar.open('Task created', 'Close', { duration: 3000 });

        if (this.attachDocsControl.value && newTaskId) {
          this.saving = false;
          this.cdr.detectChanges();
          this.openDocumentAttachDialog(newTaskId, payload.title ?? 'New Task');
        } else {
          this.dialogRef.close(true);
        }
      } else {
        const err = await res.json().catch(() => ({}));
        this.snackBar.open(err.error || 'Failed to create task', 'Close', { duration: 5000 });
        this.saving = false;
      }
    } catch (e: any) {
      this.snackBar.open('Network error: ' + e.message, 'Close', { duration: 5000 });
      this.saving = false;
    }
    this.cdr.detectChanges();
  }

  private openDocumentAttachDialog(taskId: number, taskTitle: string): void {
    const dialogData: DocumentAttachDialogData = {
      mcrId: this.data.mcrId,
      taskId,
      taskTitle
    };

    const docDialogRef = this.dialog.open(DocumentAttachDialogComponent, {
      width: '560px',
      data: dialogData
    });

    docDialogRef.afterClosed().subscribe(() => {
      this.dialogRef.close(true);
    });
  }
}
