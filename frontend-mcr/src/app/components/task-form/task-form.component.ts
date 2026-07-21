import { Component, Input, Output, EventEmitter, OnInit, inject } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { TaskService } from '../../services/task.service';
import { UserService } from '../../services/user.service';
import { ActionManagerComponent } from '../action-manager/action-manager.component';

@Component({
  selector: 'app-task-form',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
    MatIconModule,
    MatCardModule,
    MatDividerModule,
    ActionManagerComponent
  ],
  template: `
    <mat-card class="task-form-card">
      <mat-card-header>
        <mat-card-title>{{ task ? 'Edit Task' : 'New Task' }}</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <form [formGroup]="form" class="task-form">
          <!-- Row 1: Jira Reference, Start Time, Duration -->
          <div class="form-row">
            <mat-form-field appearance="outline">
              <mat-label>Jira Reference</mat-label>
              <input matInput formControlName="jira_reference" />
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Start Time</mat-label>
              <input matInput type="datetime-local" formControlName="start_time" />
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Estimated Duration (min)</mat-label>
              <input matInput type="number" formControlName="estimated_duration_mins" min="1" />
              @if (form.get('estimated_duration_mins')?.hasError('min')) {
                <mat-error>Must be at least 1 minute</mat-error>
              }
            </mat-form-field>
          </div>

          <!-- Row 2: Title -->
          <mat-form-field appearance="outline" class="full-width">
            <mat-label>Title</mat-label>
            <input matInput formControlName="title" />
            @if (form.get('title')?.hasError('required') && form.get('title')?.touched) {
              <mat-error>Title is required</mat-error>
            }
          </mat-form-field>

          <!-- Row 3: Description -->
          <mat-form-field appearance="outline" class="full-width">
            <mat-label>Description</mat-label>
            <textarea matInput formControlName="description" rows="3"></textarea>
          </mat-form-field>

          <!-- Row 4: Benefits -->
          <mat-form-field appearance="outline" class="full-width">
            <mat-label>Benefits</mat-label>
            <textarea matInput formControlName="benefits" rows="2"></textarea>
          </mat-form-field>

          <!-- Row 5: Owner Department -->
          <mat-form-field appearance="outline" class="full-width">
            <mat-label>Owner (Department)</mat-label>
            <mat-select formControlName="owner_dept_id">
              @for (dept of departments; track dept.department_id) {
                <mat-option [value]="dept.department_id">{{ dept.description }}</mat-option>
              }
            </mat-select>
          </mat-form-field>

          <!-- Row 6: Implementor Type Toggle + Selector -->
          <div class="implementor-section">
            <label class="section-label">Implementor</label>
            <mat-button-toggle-group formControlName="implementor_type" class="toggle-group">
              <mat-button-toggle value="USER">User</mat-button-toggle>
              <mat-button-toggle value="DEPARTMENT">Department</mat-button-toggle>
            </mat-button-toggle-group>

            @if (form.get('implementor_type')?.value === 'USER') {
              <mat-form-field appearance="outline" class="full-width">
                <mat-label>Select User</mat-label>
                <mat-select formControlName="implementor_id">
                  @for (user of users; track user.user_id) {
                    <mat-option [value]="user.user_id">{{ user.display_name || user.username }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
            } @else {
              <mat-form-field appearance="outline" class="full-width">
                <mat-label>Select Department</mat-label>
                <mat-select formControlName="implementor_id">
                  @for (dept of departments; track dept.department_id) {
                    <mat-option [value]="dept.department_id">{{ dept.description }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
            }
          </div>

          <mat-divider></mat-divider>

          <!-- Dependencies Section -->
          <div class="dependencies-section">
            <div class="dep-column">
              <label class="section-label">Hard Dependencies</label>
              @for (t of availableTasks; track t.task_id) {
                <mat-checkbox
                  [checked]="isHardDep(t.task_id)"
                  (change)="toggleHardDep(t.task_id, $event.checked)">
                  {{ t.task_seq }}. {{ t.title }}
                </mat-checkbox>
              }
              @if (availableTasks.length === 0) {
                <p class="hint-text">No other tasks available.</p>
              }
            </div>

            <div class="dep-column">
              <label class="section-label">Soft Dependencies</label>
              @for (t of availableTasks; track t.task_id) {
                <mat-checkbox
                  [checked]="isSoftDep(t.task_id)"
                  (change)="toggleSoftDep(t.task_id, $event.checked)">
                  {{ t.task_seq }}. {{ t.title }}
                </mat-checkbox>
              }
              @if (availableTasks.length === 0) {
                <p class="hint-text">No other tasks available.</p>
              }
            </div>
          </div>

          <mat-divider></mat-divider>

          <!-- Actions Section -->
          @if (task?.task_id) {
            <app-action-manager [taskId]="task.task_id"></app-action-manager>
          } @else {
            <div class="actions-placeholder">
              <h3>Actions</h3>
              <p class="hint-text">Save the task first to manage actions.</p>
            </div>
          }

          <mat-divider></mat-divider>

          <!-- Documents Button -->
          <div class="documents-section">
            <button mat-stroked-button (click)="openDocuments.emit()" type="button">
              <mat-icon>attach_file</mat-icon> Documents
            </button>
          </div>
        </form>
      </mat-card-content>
      <mat-card-actions align="end">
        <button mat-button (click)="onCancel()">Cancel</button>
        <button mat-flat-button color="primary" (click)="onSave()" [disabled]="form.invalid">Save</button>
      </mat-card-actions>
    </mat-card>
  `,
  styles: [`
    .task-form-card {
      max-width: 900px;
      margin: 16px auto;
    }
    .task-form {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding-top: 16px;
    }
    .form-row {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
    }
    .form-row mat-form-field {
      flex: 1;
      min-width: 200px;
    }
    .full-width {
      width: 100%;
    }
    .section-label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 8px;
      color: rgba(0, 0, 0, 0.7);
    }
    .implementor-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .toggle-group {
      margin-bottom: 8px;
    }
    .dependencies-section {
      display: flex;
      gap: 32px;
      padding: 16px 0;
    }
    .dep-column {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .hint-text {
      font-size: 13px;
      color: rgba(0, 0, 0, 0.54);
    }
    .documents-section {
      padding: 16px 0;
    }
    .actions-placeholder h3 {
      margin: 0 0 4px;
      font-size: 16px;
      font-weight: 500;
    }
    mat-divider {
      margin: 12px 0;
    }
  `]
})
export class TaskFormComponent implements OnInit {
  @Input({ required: true }) mcrId!: number;
  @Input() existingTasks: any[] = [];
  @Input() task: any | null = null;

  @Output() saved = new EventEmitter<void>();
  @Output() cancelled = new EventEmitter<void>();
  @Output() openDocuments = new EventEmitter<void>();

  private readonly fb = inject(FormBuilder);
  private readonly taskService = inject(TaskService);
  private readonly userService = inject(UserService);

  form!: FormGroup;
  users: any[] = [];
  departments: any[] = [];
  hardDeps: Set<number> = new Set();
  softDeps: Set<number> = new Set();

  get availableTasks(): any[] {
    const selfId = this.task?.task_id;
    return this.existingTasks.filter(t => t.task_id !== selfId);
  }

  ngOnInit(): void {
    this.initForm();
    this.loadLookups();

    if (this.task) {
      this.patchForm(this.task);
    }
  }

  private initForm(): void {
    this.form = this.fb.group({
      jira_reference: [''],
      start_time: [''],
      estimated_duration_mins: [null, [Validators.min(1)]],
      title: ['', Validators.required],
      description: [''],
      benefits: [''],
      owner_dept_id: [null],
      implementor_type: ['USER'],
      implementor_id: [null]
    });
  }

  private patchForm(task: any): void {
    this.form.patchValue({
      jira_reference: task.jira_reference ?? '',
      start_time: task.start_time ?? '',
      estimated_duration_mins: task.estimated_duration_mins,
      title: task.title ?? '',
      description: task.description ?? '',
      benefits: task.benefits ?? '',
      owner_dept_id: task.owner_dept_id,
      implementor_type: task.implementor_type ?? 'USER',
      implementor_id: task.implementor_id
    });

    // Load existing dependencies
    if (task.hard_dependencies) {
      task.hard_dependencies.forEach((d: any) => this.hardDeps.add(d.depends_on_task_id));
    }
    if (task.soft_dependencies) {
      task.soft_dependencies.forEach((d: any) => this.softDeps.add(d.depends_on_task_id));
    }
  }

  private loadLookups(): void {
    this.userService.getUsers().subscribe({
      next: (data) => this.users = data ?? []
    });
    this.userService.getDepartments().subscribe({
      next: (data) => this.departments = data ?? []
    });
  }

  isHardDep(taskId: number): boolean {
    return this.hardDeps.has(taskId);
  }

  isSoftDep(taskId: number): boolean {
    return this.softDeps.has(taskId);
  }

  toggleHardDep(taskId: number, checked: boolean): void {
    if (checked) {
      this.hardDeps.add(taskId);
    } else {
      this.hardDeps.delete(taskId);
    }
  }

  toggleSoftDep(taskId: number, checked: boolean): void {
    if (checked) {
      this.softDeps.add(taskId);
    } else {
      this.softDeps.delete(taskId);
    }
  }

  onSave(): void {
    if (this.form.invalid) return;

    const payload = {
      ...this.form.value,
      hard_dependencies: Array.from(this.hardDeps),
      soft_dependencies: Array.from(this.softDeps)
    };

    const request$ = this.task
      ? this.taskService.updateTask(this.task.task_id, payload)
      : this.taskService.createTask(this.mcrId, payload);

    request$.subscribe({
      next: () => this.saved.emit()
    });
  }

  onCancel(): void {
    this.cancelled.emit();
  }
}
