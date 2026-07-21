import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA, MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatListModule } from '@angular/material/list';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRadioModule } from '@angular/material/radio';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../../services/auth.service';

export interface EditTaskDialogData {
  mcrId: number;
  task: any;
  readOnly?: boolean;
  mcrStatus?: string;
  tasks?: any[];
}

@Component({
  selector: 'app-edit-task-dialog',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
    MatSnackBarModule,
    MatListModule,
    MatChipsModule,
    MatProgressSpinnerModule,
    MatRadioModule
  ],
  template: `
    <h2 mat-dialog-title>Edit Task — {{ data.task.title }}</h2>
    <mat-dialog-content>
      @if (data.readOnly) {
        <p class="readonly-note">MCR is active — changes to task details are disabled</p>
      }

      @if (data.mcrStatus === 'Active' && !isTerminalStatus(data.task.task_status) && data.task.task_status !== 'Blocked') {
        <div class="status-section">
          <h4 class="section-title">Update Status</h4>
          <mat-radio-group [(ngModel)]="selectedStatus" (change)="onDialogStatusChange()" class="status-radio-group">
            @for (opt of getDialogStatusOptions(); track opt) {
              <mat-radio-button [value]="opt" class="status-radio">{{ opt }}</mat-radio-button>
            }
          </mat-radio-group>
        </div>
      }

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
            <input matInput type="date" formControlName="start_date" />
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
        @if (linkedDocs.length > 0) {
          <div class="linked-docs-list">
            @for (doc of linkedDocs; track doc.document_id) {
              <div class="linked-doc-item">
                <mat-icon class="doc-icon">description</mat-icon>
                <span class="doc-title">{{ doc.title }}</span>
                <span class="doc-desc">{{ doc.doc_description || '' }}</span>
                <span class="doc-uploader">{{ doc.uploaded_by_name ? 'by ' + doc.uploaded_by_name : '' }}</span>
              </div>
            }
          </div>
        }
        <button mat-stroked-button (click)="openDocuments()">
          <mat-icon>attach_file</mat-icon> Attach / View Documents
        </button>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-stroked-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="onSave()" [disabled]="saving || form.invalid || data.readOnly">
        {{ saving ? 'Saving...' : 'Save Changes' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .task-form {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 500px;
      padding-top: 8px;
    }
    .full-width { width: 100%; }
    .form-row { display: flex; gap: 16px; }
    .form-row mat-form-field { flex: 1; }
    .readonly-note {
      background: #fff3e0;
      color: #e65100;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      margin-bottom: 12px;
    }
    .status-section {
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--color-line, #E8E4EE);
    }
    .status-radio-group {
      display: flex;
      flex-direction: row;
      gap: 16px;
    }
    .status-radio { font-size: 13px; }
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
    .empty-text { color: rgba(0, 0, 0, 0.54); font-size: 13px; margin: 4px 0 12px; }
    .linked-docs-list {
      margin-bottom: 12px;
    }
    .linked-doc-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
      font-size: 12px;
    }
    .doc-icon { font-size: 16px; width: 16px; height: 16px; color: var(--color-nw-purple, #5A287D); }
    .doc-title { font-weight: 500; }
    .doc-desc { color: var(--color-ink-2, #5B5B6E); }
    .doc-uploader { color: var(--color-ink-3, #9B9BAE); font-size: 11px; }
  `]
})
export class EditTaskDialogComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<EditTaskDialogComponent>);
  readonly data: EditTaskDialogData = inject(MAT_DIALOG_DATA);
  private readonly authService = inject(AuthService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly dialog = inject(MatDialog);

  departments: any[] = [];
  teams: any[] = [];
  users: any[] = [];
  otherTasks: any[] = [];
  actions: any[] = [];
  loadingActions = false;
  saving = false;
  linkedDocs: any[] = [];
  selectedStatus = '';

  subActionsControl = new FormControl('');
  backoutPlanControl = new FormControl('');

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
    this.loadActions();
    this.loadOtherTasks();
    this.loadLinkedDocs();
    this.populateForm();
    if (this.data.readOnly) {
      this.form.disable();
      this.subActionsControl.disable();
      this.backoutPlanControl.disable();
    }
  }

  private populateForm(): void {
    const t = this.data.task;

    // Build actioned_by value from implementor fields
    let actionedBy: string | null = null;
    if (t.implementor_id && t.implementor_type) {
      if (t.implementor_type === 'DEPARTMENT') {
        actionedBy = 'DEPT:' + t.implementor_id;
      } else if (t.implementor_type === 'TEAM') {
        actionedBy = 'TEAM:' + t.implementor_id;
      } else if (t.implementor_type === 'USER') {
        actionedBy = 'USER:' + t.implementor_id;
      }
    }

    const softDeps = (t.soft_dep_ids || '').split(',').filter((s: string) => s).map(Number);
    const hardDeps = (t.hard_dep_ids || '').split(',').filter((s: string) => s).map(Number);

    this.form.patchValue({
      title: t.title || '',
      description: t.description || '',
      jira_reference: t.jira_reference || '',
      estimated_duration_mins: t.estimated_duration_mins || null,
      owner_dept_id: t.owner_dept_id || null,
      benefits: t.benefits || '',
      actioned_by: actionedBy,
      start_date: t.est_start_date || '',
      start_time: t.est_start_time || '',
      soft_dependencies: softDeps,
      hard_dependencies: hardDeps
    });

    this.backoutPlanControl.setValue(t.backout_plan || '');

    // Pre-populate sub_actions from task data
    if (t.sub_actions) {
      this.subActionsControl.setValue(t.sub_actions);
    }
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
        const allTasks = data?.items ?? (Array.isArray(data) ? data : []);
        this.otherTasks = allTasks.filter((t: any) => t.task_id !== this.data.task.task_id);
      }
    } catch {
      this.otherTasks = [];
    }
    this.cdr.detectChanges();
  }

  async loadActions(): Promise<void> {
    this.loadingActions = true;
    this.cdr.detectChanges();

    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/actions/${this.data.task.task_id}`);
      if (res.ok) {
        const data = await res.json();
        this.actions = data?.items ?? (Array.isArray(data) ? data : []);
        // Only pre-populate from actions if task doesn't already have sub_actions saved
        if (!this.data.task.sub_actions) {
          const actionText = this.actions
            .map((a: any) => a.description || a.action_type || '')
            .filter((s: string) => s.length > 0)
            .join('\n');
          this.subActionsControl.setValue(actionText);
        }
      }
    } catch {
      this.actions = [];
    }

    this.loadingActions = false;
    this.cdr.detectChanges();
  }

  openDocuments(): void {
    import('./document-attach-dialog.component').then(m => {
      this.dialog.open(m.DocumentAttachDialogComponent, {
        width: '550px',
        data: {
          mcrId: this.data.mcrId,
          taskId: this.data.task.task_id,
          taskTitle: this.data.task.title
        }
      });
    });
  }

  async loadLinkedDocs(): Promise<void> {
    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/documents/links/${this.data.task.task_id}`);
      if (res.ok) {
        const data = await res.json();
        this.linkedDocs = data?.items ?? [];
      }
    } catch {}
    this.cdr.detectChanges();
  }

  isTerminalStatus(status: string): boolean {
    return ['Complete', 'Cancelled', 'Failed', 'Approved'].includes(status);
  }

  getDialogStatusOptions(): string[] {
    const task = this.data.task;
    const tasks = this.data.tasks || [];
    // Check hard dependencies — must be Complete for "Complete" option
    const hardDeps = (task.hard_dep_ids || '').split(',').filter(Boolean).map(Number);
    const allHardMet = hardDeps.every((depId: number) => {
      const dep = tasks.find((t: any) => t.task_id === depId);
      return dep && dep.task_status === 'Complete';
    });
    // Check soft dependencies — must reach terminal state for "Complete" option
    const softDeps = (task.soft_dep_ids || '').split(',').filter(Boolean).map(Number);
    const allSoftMet = softDeps.every((depId: number) => {
      const dep = tasks.find((t: any) => t.task_id === depId);
      return dep && ['Complete', 'Cancelled', 'Failed'].includes(dep.task_status);
    });
    const depsBlocked = (!allHardMet && hardDeps.length > 0) || (!allSoftMet && softDeps.length > 0);
    if (depsBlocked) {
      // Can still cancel or fail, but not complete
      return ['Cancelled', 'Failed'];
    }
    return ['Complete', 'Cancelled', 'Failed'];
  }

  async onDialogStatusChange(): Promise<void> {
    if (!this.selectedStatus) return;
    const userId = this.authService.getCurrentUserId();
    const payload = {
      user_id: userId,
      task_id: this.data.task.task_id,
      new_status: this.selectedStatus
    };
    try {
      const res = await fetch('/ords/jit_schema/mcr/v1/tasks/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        this.data.task.task_status = this.selectedStatus;
        this.snackBar.open(`Status updated to ${this.selectedStatus}`, 'OK', { duration: 3000 });
        this.dialogRef.close(true);
      } else {
        this.snackBar.open('Failed to update status', 'OK', { duration: 4000 });
      }
    } catch {
      this.snackBar.open('Network error updating status', 'OK', { duration: 4000 });
    }
    this.cdr.detectChanges();
  }

  async onSave(): Promise<void> {
    if (this.form.invalid) return;
    this.saving = true;
    this.cdr.detectChanges();

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
    }

    const payload = {
      user_id: userId,
      task_id: this.data.task.task_id,
      title: this.form.value.title,
      description: this.form.value.description || null,
      jira_reference: this.form.value.jira_reference || null,
      estimated_duration_mins: this.form.value.estimated_duration_mins || null,
      owner_dept_id: this.form.value.owner_dept_id || null,
      benefits: this.form.value.benefits || null,
      implementor_type,
      implementor_id,
      start_date: this.form.value.start_date || null,
      start_time: this.form.value.start_time || null,
      soft_deps_csv: (this.form.value.soft_dependencies ?? []).join(','),
      hard_deps_csv: (this.form.value.hard_dependencies ?? []).join(','),
      sub_actions: this.subActionsControl.value || null,
      backout_plan: this.backoutPlanControl.value || null
    };

    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/tasks/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        this.snackBar.open('Task updated', 'Close', { duration: 3000 });
        this.dialogRef.close(true);
      } else {
        const err = await res.json().catch(() => ({}));
        this.snackBar.open(err.error || 'Failed to update task', 'Close', { duration: 5000 });
        this.saving = false;
      }
    } catch (e: any) {
      this.snackBar.open('Network error: ' + e.message, 'Close', { duration: 5000 });
      this.saving = false;
    }
    this.cdr.detectChanges();
  }
}
