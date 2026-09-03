import { Component, OnInit, inject, ChangeDetectorRef, AfterViewInit, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDividerModule } from '@angular/material/divider';
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';

@Component({
  selector: 'app-model-detail-dialog',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
    MatTableModule,
    MatSnackBarModule,
    MatProgressSpinnerModule,
    MatDividerModule
  ],
  template: `
    <h2 mat-dialog-title>{{ model?.model_name || 'Model Detail' }}</h2>
    <mat-dialog-content class="detail-content">
      @if (loading) {
        <div class="loading-container">
          <mat-spinner diameter="36"></mat-spinner>
        </div>
      } @else {
        <p class="model-description">{{ model?.description || 'No description' }}</p>

        <mat-divider></mat-divider>

        <div class="tasks-header">
          <h3>Tasks</h3>
          <div class="tasks-header-actions">
            <button mat-stroked-button (click)="showDescriptions = !showDescriptions; cdr.detectChanges()">
              <mat-icon>{{ showDescriptions ? 'visibility_off' : 'visibility' }}</mat-icon> Descriptions
            </button>
            <button mat-raised-button color="primary" (click)="showTaskForm = true; editingTask = null; resetTaskForm()">
              <mat-icon>add</mat-icon> Add Task
            </button>
          </div>
        </div>

        @if (showTaskForm) {
          <div class="task-form-container">
            <h4>{{ editingTask ? 'Edit Task' : 'New Task' }}</h4>
            <form [formGroup]="taskForm" class="task-form">
              <mat-form-field appearance="outline" class="full-width">
                <mat-label>Title</mat-label>
                <input matInput formControlName="title" />
                @if (taskForm.get('title')?.hasError('required') && taskForm.get('title')?.touched) {
                  <mat-error>Title is required</mat-error>
                }
              </mat-form-field>

              <mat-form-field appearance="outline" class="full-width">
                <mat-label>Description</mat-label>
                <textarea matInput formControlName="description" rows="2"></textarea>
              </mat-form-field>

              <div class="form-row">
                <mat-form-field appearance="outline">
                  <mat-label>Owner Department</mat-label>
                  <mat-select formControlName="owner_dept_id">
                    @for (dept of departments; track dept.department_id) {
                      <mat-option [value]="dept.department_id">{{ dept.description }}</mat-option>
                    }
                  </mat-select>
                </mat-form-field>

                <mat-form-field appearance="outline">
                  <mat-label>Implementor Type</mat-label>
                  <mat-select formControlName="implementor_type">
                    <mat-option value="USER">User</mat-option>
                    <mat-option value="DEPARTMENT">Department</mat-option>
                  </mat-select>
                </mat-form-field>

                <mat-form-field appearance="outline">
                  <mat-label>Implementor</mat-label>
                  @if (taskForm.get('implementor_type')?.value === 'USER') {
                    <mat-select formControlName="implementor_id">
                      @for (user of users; track user.user_id) {
                        <mat-option [value]="user.user_id">{{ user.display_name || user.username }}</mat-option>
                      }
                    </mat-select>
                  } @else {
                    <mat-select formControlName="implementor_id">
                      @for (dept of departments; track dept.department_id) {
                        <mat-option [value]="dept.department_id">{{ dept.description }}</mat-option>
                      }
                    </mat-select>
                  }
                </mat-form-field>
              </div>

              <mat-form-field appearance="outline" class="full-width">
                <mat-label>Benefits</mat-label>
                <textarea matInput formControlName="benefits" rows="2"></textarea>
              </mat-form-field>

              <div class="form-row">
                <mat-form-field appearance="outline">
                  <mat-label>Sub-Actions</mat-label>
                  <textarea matInput formControlName="sub_actions" rows="2"></textarea>
                </mat-form-field>

                <mat-form-field appearance="outline">
                  <mat-label>Backout Plan</mat-label>
                  <textarea matInput formControlName="backout_plan" rows="2"></textarea>
                </mat-form-field>
              </div>

              <div class="form-row">
                <mat-form-field appearance="outline">
                  <mat-label>Duration (mins)</mat-label>
                  <input matInput type="number" formControlName="estimated_duration_mins" min="1" />
                </mat-form-field>

                <mat-form-field appearance="outline">
                  <mat-label>Soft Dep Seqs (comma-sep)</mat-label>
                  <input matInput formControlName="soft_dep_seqs" placeholder="e.g. 1,2" />
                </mat-form-field>

                <mat-form-field appearance="outline">
                  <mat-label>Hard Dep Seqs (comma-sep)</mat-label>
                  <input matInput formControlName="hard_dep_seqs" placeholder="e.g. 1,3" />
                </mat-form-field>
              </div>

              <div class="form-actions">
                <button mat-button (click)="showTaskForm = false">Cancel</button>
                <button mat-raised-button color="primary" (click)="saveTask()" [disabled]="savingTask || taskForm.invalid">
                  {{ savingTask ? 'Saving...' : (editingTask ? 'Update' : 'Add') }}
                </button>
              </div>
            </form>
          </div>
          <mat-divider></mat-divider>
        }

        @if (tasks.length === 0 && !showTaskForm) {
          <p class="empty-text">No tasks defined for this model.</p>
        } @else if (tasks.length > 0) {
          <!-- Dependency Map (Cytoscape) -->
          <div class="dep-map-section">
            <div class="dep-map-header">
              <h3>Dependency Map</h3>
              <button mat-stroked-button (click)="toggleFullscreenMap()">
                <mat-icon>{{ fullscreenMap ? 'fullscreen_exit' : 'fullscreen' }}</mat-icon>
                {{ fullscreenMap ? 'Exit Fullscreen' : 'Fullscreen' }}
              </button>
            </div>
            <div class="zoom-controls">
              <button mat-icon-button (click)="zoomIn()"><mat-icon>zoom_in</mat-icon></button>
              <button mat-icon-button (click)="zoomOut()"><mat-icon>zoom_out</mat-icon></button>
              <button mat-icon-button (click)="fitMap()"><mat-icon>fit_screen</mat-icon></button>
              <span style="flex:1"></span>
              <button mat-stroked-button (click)="savePositions()"><mat-icon>save</mat-icon> Save Layout</button>
            </div>
            <div class="cytoscape-container" [class.fullscreen]="fullscreenMap" #cyContainer></div>
            <div class="legend">
              <div class="legend-item"><span class="dot" style="background:#5A287D"></span> Model Root</div>
              <div class="legend-item"><span class="dot" style="background:#F3EFF8; border: 2px solid #5A287D"></span> Task</div>
              <div class="legend-item">
                <svg width="30" height="12"><line x1="0" y1="6" x2="30" y2="6" stroke="#5A287D" stroke-width="2" /></svg>
                <span>Must Succeed</span>
              </div>
              <div class="legend-item">
                <svg width="30" height="12"><line x1="0" y1="6" x2="30" y2="6" stroke="#9B9BAE" stroke-width="1.5" stroke-dasharray="5,3" /></svg>
                <span>Any Status</span>
              </div>
            </div>
          </div>

          <mat-divider></mat-divider>

          <div class="tasks-list-header"><h3>Task List</h3></div>
          <div class="table-container">
            <table mat-table [dataSource]="tasks" class="tasks-table">
              <ng-container matColumnDef="seq">
                <th mat-header-cell *matHeaderCellDef>Seq</th>
                <td mat-cell *matCellDef="let task; let i = index">{{ i + 1 }}</td>
              </ng-container>

              <ng-container matColumnDef="title">
                <th mat-header-cell *matHeaderCellDef>Title</th>
                <td mat-cell *matCellDef="let task">{{ task.title }}</td>
              </ng-container>

              <ng-container matColumnDef="description">
                <th mat-header-cell *matHeaderCellDef>Description</th>
                <td mat-cell *matCellDef="let task">{{ task.description || '—' }}</td>
              </ng-container>

              <ng-container matColumnDef="owner">
                <th mat-header-cell *matHeaderCellDef>Owner</th>
                <td mat-cell *matCellDef="let task">{{ getDeptName(task.owner_dept_id) }}</td>
              </ng-container>

              <ng-container matColumnDef="duration">
                <th mat-header-cell *matHeaderCellDef>Duration</th>
                <td mat-cell *matCellDef="let task">{{ task.estimated_duration_mins ? task.estimated_duration_mins + ' min' : '—' }}</td>
              </ng-container>

              <ng-container matColumnDef="hard_deps">
                <th mat-header-cell *matHeaderCellDef>Must Succeed</th>
                <td mat-cell *matCellDef="let task">{{ task.hard_dep_seqs || '—' }}</td>
              </ng-container>

              <ng-container matColumnDef="soft_deps">
                <th mat-header-cell *matHeaderCellDef>Any Status</th>
                <td mat-cell *matCellDef="let task">{{ task.soft_dep_seqs || '—' }}</td>
              </ng-container>

              <ng-container matColumnDef="actions">
                <th mat-header-cell *matHeaderCellDef>Actions</th>
                <td mat-cell *matCellDef="let task">
                  <button mat-icon-button color="primary" (click)="editTask(task)" aria-label="Edit task">
                    <mat-icon>edit</mat-icon>
                  </button>
                  <button mat-icon-button color="warn" (click)="deleteTask(task)" aria-label="Delete task">
                    <mat-icon>delete</mat-icon>
                  </button>
                </td>
              </ng-container>

              <tr mat-header-row *matHeaderRowDef="visibleColumns"></tr>
              <tr mat-row *matRowDef="let row; columns: visibleColumns;"></tr>
            </table>
          </div>
        }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (showTaskForm) {
        <button mat-stroked-button (click)="showTaskForm = false">Back to Tasks</button>
      } @else {
        <button mat-stroked-button mat-dialog-close>Close</button>
      }
    </mat-dialog-actions>
  `,
  styles: [`
    .detail-content {
      min-width: 600px;
      width: 100%;
    }
    .model-description {
      color: var(--color-ink-2, #5B5B6E);
      font-size: 14px;
      margin: 8px 0 16px;
    }
    .loading-container {
      display: flex;
      justify-content: center;
      padding: 48px;
    }
    .tasks-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 16px 0;
    }
    .tasks-header h3 {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
      color: var(--color-ink, #1A1A2E);
    }
    .task-form-container {
      padding: 16px;
      background: var(--color-bg-muted, #F8F7FA);
      border-radius: 8px;
      margin-bottom: 16px;
    }
    .task-form-container h4 {
      margin: 0 0 12px;
      font-size: 14px;
      font-weight: 600;
    }
    .task-form {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .form-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .form-row mat-form-field {
      flex: 1;
      min-width: 180px;
    }
    .full-width {
      width: 100%;
    }
    .form-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }
    .table-container {
      overflow-x: auto;
    }
    .tasks-table {
      width: 100%;
    }
    .empty-text {
      color: var(--color-ink-3, #9B9BAE);
      font-size: 14px;
    }
    .dep-map-section {
      margin-bottom: 16px;
    }
    .dep-map-section h3, .tasks-list-header h3 {
      margin: 16px 0 12px;
      font-size: 16px;
      font-weight: 700;
      color: var(--color-ink, #1A1A2E);
    }
    .dep-map-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 16px 0 8px;
    }
    .dep-map-header h3 {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
      color: var(--color-ink, #1A1A2E);
    }
    .zoom-controls {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 6px;
    }
    .cytoscape-container {
      width: 100%;
      height: 420px;
      border: 1px solid var(--color-line, #E8E4EE);
      border-radius: 8px;
      background: var(--color-bg-muted, #F8F7FA);
      transition: height 0.3s ease;
    }
    .cytoscape-container.fullscreen {
      height: calc(100vh - 250px);
    }
    .tasks-header-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .legend {
      display: flex;
      gap: 20px;
      padding: 10px 0 0;
      font-size: 12px;
      color: var(--color-ink-2, #5B5B6E);
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      display: inline-block;
    }
  `]
})
export class ModelDetailDialogComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<ModelDetailDialogComponent>);
  private readonly data: any = inject(MAT_DIALOG_DATA);
  private readonly snackBar = inject(MatSnackBar);
  readonly cdr = inject(ChangeDetectorRef);

  @ViewChild('cyContainer', { static: false }) cyContainer!: ElementRef;
  private cy: any = null;

  model: any = null;
  tasks: any[] = [];
  departments: any[] = [];
  users: any[] = [];
  loading = true;
  showTaskForm = false;
  savingTask = false;
  editingTask: any = null;
  showDescriptions = false;
  fullscreenMap = false;

  readonly taskColumns = ['seq', 'title', 'description', 'owner', 'duration', 'hard_deps', 'soft_deps', 'actions'];

  get visibleColumns(): string[] {
    return this.showDescriptions
      ? ['seq', 'title', 'description', 'owner', 'duration', 'hard_deps', 'soft_deps', 'actions']
      : ['seq', 'title', 'owner', 'duration', 'hard_deps', 'soft_deps', 'actions'];
  }

  taskForm = new FormGroup({
    title: new FormControl('', [Validators.required]),
    description: new FormControl(''),
    owner_dept_id: new FormControl<number | null>(null),
    implementor_id: new FormControl<number | null>(null),
    implementor_type: new FormControl('USER'),
    benefits: new FormControl(''),
    sub_actions: new FormControl(''),
    backout_plan: new FormControl(''),
    estimated_duration_mins: new FormControl<number | null>(null),
    soft_dep_seqs: new FormControl(''),
    hard_dep_seqs: new FormControl('')
  });

  ngOnInit(): void {
    this.loadModel();
    this.loadLookups();
  }

  async loadModel(): Promise<void> {
    this.loading = true;
    this.cdr.detectChanges();

    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/models/${this.data.model_id}`);
      if (res.ok) {
        const data = await res.json();
        this.model = data;
        this.tasks = data?.tasks ?? data?.items ?? [];
      }
    } catch {
      this.snackBar.open('Failed to load model details', 'Close', { duration: 5000 });
    }

    // Load saved positions
    let savedPositions: { node_id: string; pos_x: number; pos_y: number }[] = [];
    try {
      const posRes = await fetch(`/ords/jit_schema/mcr/v1/map-positions/MODEL/${this.data.model_id}`);
      if (posRes.ok) {
        const posData = await posRes.json();
        savedPositions = posData?.items ?? [];
      }
    } catch {
      // Positions not available, will use dagre layout
    }

    this.loading = false;
    this.cdr.detectChanges();

    // Build Cytoscape graph after view updates
    setTimeout(() => this.renderCytoscapeGraph(savedPositions), 100);
  }

  private renderCytoscapeGraph(savedPositions: { node_id: string; pos_x: number; pos_y: number }[] = []): void {
    if (!this.cyContainer?.nativeElement || this.tasks.length === 0) return;

    // Register dagre layout
    if (!(cytoscape as any).extensions?.layout?.dagre) {
      cytoscape.use(dagre);
    }

    const elements: any[] = [];

    // Root node
    elements.push({
      data: { id: 'root', label: this.model?.model_name || 'Model' },
      classes: 'root'
    });

    // Task nodes
    this.tasks.forEach((task: any, i: number) => {
      const seq = task.task_seq ?? (i + 1);
      elements.push({
        data: {
          id: `t-${seq}`,
          label: `${seq}. ${task.title}`,
          seq,
          title: task.title,
          duration: task.estimated_duration_mins
        },
        classes: 'task'
      });

      let hasParent = false;

      // Hard dependency edges
      if (task.hard_dep_seqs) {
        String(task.hard_dep_seqs).split(',').map(s => s.trim()).filter(s => s).forEach(depSeq => {
          elements.push({
            data: { source: `t-${depSeq}`, target: `t-${seq}` },
            classes: 'hard'
          });
          hasParent = true;
        });
      }

      // Soft dependency edges
      if (task.soft_dep_seqs) {
        String(task.soft_dep_seqs).split(',').map(s => s.trim()).filter(s => s).forEach(depSeq => {
          elements.push({
            data: { source: `t-${depSeq}`, target: `t-${seq}` },
            classes: 'soft'
          });
          hasParent = true;
        });
      }

      // Tasks with no dependencies connect from root
      if (!hasParent) {
        elements.push({
          data: { source: 'root', target: `t-${seq}` },
          classes: 'soft'
        });
      }
    });

    // Destroy previous instance
    if (this.cy) {
      this.cy.destroy();
    }

    // Determine layout: preset (saved positions) or dagre
    const posMap = new Map<string, { x: number; y: number }>();
    savedPositions.forEach(p => posMap.set(p.node_id, { x: p.pos_x, y: p.pos_y }));
    const usePreset = posMap.size > 0;

    const layoutConfig: any = usePreset
      ? {
          name: 'preset',
          positions: (node: any) => {
            const pos = posMap.get(node.id());
            return pos ? { x: pos.x, y: pos.y } : { x: 0, y: 0 };
          }
        }
      : {
          name: 'dagre',
          rankDir: 'TB',
          nodeSep: 50,
          rankSep: 70,
          edgeSep: 20,
          padding: 30
        };

    this.cy = cytoscape({
      container: this.cyContainer.nativeElement,
      elements,
      layout: layoutConfig,
      style: [
        {
          selector: 'node.root',
          style: {
            'background-color': '#5A287D',
            'label': 'data(label)',
            'color': '#fff',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '11px',
            'font-weight': 'bold',
            'width': 140,
            'height': 36,
            'shape': 'round-rectangle',
            'text-max-width': '120px',
            'text-wrap': 'ellipsis'
          }
        },
        {
          selector: 'node.task',
          style: {
            'background-color': '#F3EFF8',
            'border-color': '#5A287D',
            'border-width': 1.5,
            'label': 'data(label)',
            'color': '#1A1A2E',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '10px',
            'font-weight': 'normal',
            'width': 160,
            'height': 32,
            'shape': 'round-rectangle',
            'text-max-width': '140px',
            'text-wrap': 'ellipsis'
          }
        },
        {
          selector: 'node.task:active, node.task:selected',
          style: {
            'background-color': '#E8E0F0',
            'border-width': 2.5,
            'border-color': '#7A4A9E'
          }
        },
        {
          selector: 'edge.hard',
          style: {
            'line-color': '#5A287D',
            'target-arrow-color': '#5A287D',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'width': 2,
            'arrow-scale': 0.8
          }
        },
        {
          selector: 'edge.soft',
          style: {
            'line-color': '#9B9BAE',
            'target-arrow-color': '#9B9BAE',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'width': 1.5,
            'line-style': 'dashed',
            'line-dash-pattern': [6, 4],
            'arrow-scale': 0.7
          }
        }
      ],
      userZoomingEnabled: false,
      userPanningEnabled: true,
      boxSelectionEnabled: false
    });

    // Fit to viewport
    this.cy.fit(undefined, 30);

    // Click handler on task nodes (future: expand details, navigate)
    this.cy.on('tap', 'node.task', (evt: any) => {
      const node = evt.target;
      const title = node.data('title');
      const seq = node.data('seq');
      const duration = node.data('duration');
      this.snackBar.open(
        `Task ${seq}: ${title}${duration ? ' (' + duration + ' min)' : ''}`,
        'OK',
        { duration: 3000 }
      );
    });
  }

  async loadLookups(): Promise<void> {
    try {
      const [deptRes, userRes] = await Promise.all([
        fetch('/ords/jit_schema/mcr/v1/users/departments'),
        fetch('/ords/jit_schema/mcr/v1/users/')
      ]);
      if (deptRes.ok) {
        const d = await deptRes.json();
        this.departments = d?.items ?? (Array.isArray(d) ? d : []);
      }
      if (userRes.ok) {
        const u = await userRes.json();
        this.users = u?.items ?? (Array.isArray(u) ? u : []);
      }
    } catch {
      // silently fail lookups
    }
    this.cdr.detectChanges();
  }

  getDeptName(deptId: number | null): string {
    if (!deptId) return '—';
    const dept = this.departments.find(d => d.department_id === deptId);
    return dept?.description ?? '—';
  }

  resetTaskForm(): void {
    this.taskForm.reset({ implementor_type: 'USER' });
  }

  editTask(task: any): void {
    this.editingTask = task;
    this.showTaskForm = true;
    this.taskForm.patchValue({
      title: task.title ?? '',
      description: task.description ?? '',
      owner_dept_id: task.owner_dept_id ?? null,
      implementor_id: task.implementor_id ?? null,
      implementor_type: task.implementor_type ?? 'USER',
      benefits: task.benefits ?? '',
      sub_actions: task.sub_actions ?? '',
      backout_plan: task.backout_plan ?? '',
      estimated_duration_mins: task.estimated_duration_mins ?? null,
      soft_dep_seqs: task.soft_dep_seqs ?? '',
      hard_dep_seqs: task.hard_dep_seqs ?? ''
    });
    this.cdr.detectChanges();
    setTimeout(() => {
      const el = document.querySelector('.task-form-container');
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  async saveTask(): Promise<void> {
    this.taskForm.markAllAsTouched();
    if (this.taskForm.invalid) return;

    this.savingTask = true;
    this.cdr.detectChanges();

    const val = this.taskForm.value;
    const payload: any = {
      title: val.title,
      description: val.description || '',
      owner_dept_id: val.owner_dept_id || null,
      implementor_id: val.implementor_id || null,
      implementor_type: val.implementor_type || 'USER',
      benefits: val.benefits || '',
      sub_actions: val.sub_actions || '',
      backout_plan: val.backout_plan || '',
      estimated_duration_mins: val.estimated_duration_mins || null,
      soft_dep_seqs: val.soft_dep_seqs || '',
      hard_dep_seqs: val.hard_dep_seqs || ''
    };

    try {
      let res: Response;
      if (this.editingTask) {
        res = await fetch(`/ords/jit_schema/mcr/v1/models/tasks/${this.editingTask.model_task_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } else {
        res = await fetch(`/ords/jit_schema/mcr/v1/models/${this.data.model_id}/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

      if (res.ok || res.status === 201) {
        this.snackBar.open(this.editingTask ? 'Task updated' : 'Task added', 'Close', { duration: 3000 });
        this.showTaskForm = false;
        this.editingTask = null;
        this.resetTaskForm();
        await this.loadModel();
      } else {
        const err = await res.json().catch(() => ({}));
        this.snackBar.open(err.message || 'Failed to save task', 'Close', { duration: 5000 });
      }
    } catch (e: any) {
      this.snackBar.open('Network error: ' + e.message, 'Close', { duration: 5000 });
    }

    this.savingTask = false;
    this.cdr.detectChanges();
  }

  async deleteTask(task: any): Promise<void> {
    if (!confirm(`Delete task "${task.title}"?`)) return;

    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/models/tasks/${task.model_task_id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        this.snackBar.open('Task deleted', 'Close', { duration: 3000 });
        await this.loadModel();
      } else {
        this.snackBar.open('Failed to delete task', 'Close', { duration: 5000 });
      }
    } catch (e: any) {
      this.snackBar.open('Network error: ' + e.message, 'Close', { duration: 5000 });
    }
    this.cdr.detectChanges();
  }

  zoomIn(): void {
    if (!this.cy) return;
    this.cy.zoom(this.cy.zoom() * 1.2);
    this.cy.center();
  }

  zoomOut(): void {
    if (!this.cy) return;
    this.cy.zoom(this.cy.zoom() / 1.2);
    this.cy.center();
  }

  fitMap(): void {
    if (!this.cy) return;
    this.cy.fit(undefined, 30);
  }

  toggleFullscreenMap(): void {
    this.fullscreenMap = !this.fullscreenMap;
    this.cdr.detectChanges();
    // Resize cytoscape after container height changes
    setTimeout(() => {
      if (this.cy) {
        this.cy.resize();
        this.cy.fit(undefined, 30);
      }
    }, 350);
  }

  async savePositions(): Promise<void> {
    if (!this.cy) return;
    const positions = this.cy.nodes().map((node: any) => ({
      id: node.id(),
      x: Math.round(node.position('x')),
      y: Math.round(node.position('y'))
    }));

    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/map-positions/MODEL/${this.data.model_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions })
      });
      if (res.ok || res.status === 201) {
        this.snackBar.open('Layout saved', 'OK', { duration: 2000 });
      } else {
        this.snackBar.open('Failed to save layout', 'Close', { duration: 4000 });
      }
    } catch {
      this.snackBar.open('Failed to save layout', 'Close', { duration: 4000 });
    }
  }
}
