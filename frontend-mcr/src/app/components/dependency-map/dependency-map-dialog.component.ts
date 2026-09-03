import { Component, OnInit, inject, ChangeDetectorRef, ElementRef, ViewChild, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialog, MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { AuthService } from '../../services/auth.service';
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';

export interface DependencyMapDialogData {
  mcrId: number;
  mcrNumber?: string;
}

@Component({
  selector: 'app-dependency-map-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSnackBarModule
  ],
  template: `
    <h2 mat-dialog-title>Dependency Map — {{ data.mcrNumber || 'MCR' }}</h2>
    <mat-dialog-content class="map-content">
      @if (loading) {
        <div class="loading-container">
          <mat-spinner diameter="40"></mat-spinner>
        </div>
      } @else if (error) {
        <p class="error-text">{{ error }}</p>
      } @else {
        <div class="map-toolbar">
          <button mat-icon-button (click)="zoomIn()" aria-label="Zoom in"><mat-icon>zoom_in</mat-icon></button>
          <button mat-icon-button (click)="zoomOut()" aria-label="Zoom out"><mat-icon>zoom_out</mat-icon></button>
          <button mat-icon-button (click)="fitMap()" aria-label="Fit to screen"><mat-icon>fit_screen</mat-icon></button>
          <button mat-icon-button (click)="toggleFullscreen()" [attr.aria-label]="fullscreen ? 'Exit fullscreen' : 'Fullscreen'">
            <mat-icon>{{ fullscreen ? 'fullscreen_exit' : 'fullscreen' }}</mat-icon>
          </button>
          <span class="spacer"></span>
          <button mat-stroked-button (click)="savePositions()">
            <mat-icon>save</mat-icon> Save Layout
          </button>
        </div>
        <div class="cytoscape-container" [class.fullscreen]="fullscreen" #cyContainer></div>
        <div class="legend">
          <div class="legend-item"><span class="dot" style="background:#4caf50"></span> Complete</div>
          <div class="legend-item"><span class="dot" style="background:#2196F3"></span> Approved / Ready</div>
          <div class="legend-item"><span class="dot" style="background:#7B1FA2"></span> Started</div>
          <div class="legend-item"><span class="dot" style="background:#f44336"></span> Failed</div>
          <div class="legend-item"><span class="dot" style="background:#9e9e9e"></span> Cancelled</div>
          <div class="legend-item"><span class="dot" style="background:#ff9800"></span> Blocked (Dep)</div>
          <div class="legend-item"><span class="dot" style="background:#E0E0E0; border: 1px solid #BDBDBD"></span> Draft</div>
          <div class="legend-item">
            <svg width="30" height="12"><line x1="0" y1="6" x2="30" y2="6" stroke="#5A287D" stroke-width="2" /></svg>
            <span>Hard dep</span>
          </div>
          <div class="legend-item">
            <svg width="30" height="12"><line x1="0" y1="6" x2="30" y2="6" stroke="#9B9BAE" stroke-width="1.5" stroke-dasharray="5,3" /></svg>
            <span>Soft dep</span>
          </div>
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-stroked-button mat-dialog-close>Close</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .map-content {
      min-width: 600px;
      min-height: 400px;
    }
    .loading-container {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 300px;
    }
    .error-text {
      color: #f44336;
      text-align: center;
      padding: 24px;
    }
    .map-toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 8px;
    }
    .spacer {
      flex: 1;
    }
    .cytoscape-container {
      width: 100%;
      height: 500px;
      border: 1px solid var(--color-line, #E8E4EE);
      border-radius: 8px;
      background: var(--color-bg-muted, #F8F7FA);
      transition: height 0.3s ease;
    }
    .cytoscape-container.fullscreen {
      height: calc(100vh - 200px);
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      padding: 12px 0 0;
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
export class DependencyMapDialogComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<DependencyMapDialogComponent>);
  readonly data: DependencyMapDialogData = inject(MAT_DIALOG_DATA);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly dialog = inject(MatDialog);
  private readonly authService = inject(AuthService);
  private readonly snackBar = inject(MatSnackBar);

  @ViewChild('cyContainer', { static: false }) cyContainer!: ElementRef;
  private cy: any = null;

  loading = true;
  error: string | null = null;
  fullscreen = false;
  private taskData: any[] = [];
  private mcrActive = false;

  ngOnInit(): void {
    this.loadDependencyMap();
  }

  private async loadDependencyMap(): Promise<void> {
    this.loading = true;
    this.cdr.detectChanges();

    try {
      const headers: Record<string, string> = {
        'X-User-Id': String(this.authService.getCurrentUserId())
      };

      // Fetch MCR status
      const mcrRes = await fetch(`/ords/jit_schema/mcr/v1/requests/${this.data.mcrId}`, { headers });
      if (mcrRes.ok) {
        const mcrData = await mcrRes.json();
        this.mcrActive = (mcrData?.mcr_status || '').toUpperCase() === 'ACTIVE';
      }

      // Fetch tasks
      const res = await fetch(`/ords/jit_schema/mcr/v1/tasks/mcr/${this.data.mcrId}`, { headers });
      if (!res.ok) {
        this.error = 'Failed to load dependency map.';
        this.loading = false;
        this.cdr.detectChanges();
        return;
      }
      const data = await res.json();
      this.taskData = data?.items ?? (Array.isArray(data) ? data : []);

      // Load saved positions
      let savedPositions: { node_id: string; pos_x: number; pos_y: number }[] = [];
      try {
        const posRes = await fetch(`/ords/jit_schema/mcr/v1/map-positions/MCR/${this.data.mcrId}`, { headers });
        if (posRes.ok) {
          const posData = await posRes.json();
          savedPositions = posData?.items ?? [];
        }
      } catch {
        // Positions not available, will use dagre layout
      }

      this.loading = false;
      this.cdr.detectChanges();

      // Render graph after view updates
      setTimeout(() => this.renderGraph(savedPositions), 100);
    } catch {
      this.error = 'Failed to load dependency map.';
      this.loading = false;
      this.cdr.detectChanges();
    }
  }

  private renderGraph(savedPositions: { node_id: string; pos_x: number; pos_y: number }[]): void {
    if (!this.cyContainer?.nativeElement) return;

    // Register dagre layout
    if (!(cytoscape as any).extensions?.layout?.dagre) {
      cytoscape.use(dagre);
    }

    const elements: any[] = [];
    const tasks = this.taskData;
    const mcrTitle = this.data.mcrNumber || 'MCR';

    // Root node
    elements.push({
      data: { id: 'root', label: mcrTitle },
      classes: 'root'
    });

    // Task nodes
    tasks.forEach((task: any, i: number) => {
      const seq = task.task_seq ?? (i + 1);
      const status = this.mcrActive
        ? this.getEffectiveStatus(task, tasks)
        : 'DRAFT';

      elements.push({
        data: {
          id: `task-${task.task_id}`,
          label: `${seq}. ${task.title}`,
          status
        },
        classes: 'task'
      });

      let hasParent = false;

      // Hard dependency edges
      const hardDeps = (task.hard_dep_ids || '').split(',').filter(Boolean).map(Number);
      hardDeps.forEach((depId: number) => {
        elements.push({
          data: { source: `task-${depId}`, target: `task-${task.task_id}` },
          classes: 'hard'
        });
        hasParent = true;
      });

      // Soft dependency edges
      const softDeps = (task.soft_dep_ids || '').split(',').filter(Boolean).map(Number);
      softDeps.forEach((depId: number) => {
        elements.push({
          data: { source: `task-${depId}`, target: `task-${task.task_id}` },
          classes: 'soft'
        });
        hasParent = true;
      });

      // Tasks with no deps connect from root with soft edge
      if (!hasParent) {
        elements.push({
          data: { source: 'root', target: `task-${task.task_id}` },
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
            'background-color': (ele: any) => this.getNodeColor(ele.data('status')),
            'border-color': (ele: any) => this.getNodeBorder(ele.data('status')),
            'border-width': 2,
            'label': 'data(label)',
            'color': (ele: any) => this.getNodeTextColor(ele.data('status')),
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
            'border-width': 3,
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

    // Click handler on task nodes
    this.cy.on('tap', 'node.task', (evt: any) => {
      const node = evt.target;
      const taskId = node.id().replace('task-', '');
      const task = this.taskData.find((t: any) => String(t.task_id) === taskId);
      if (task) {
        import('../../views/active/task-detail/text-view-dialog.component').then(m => {
          this.dialog.open(m.TextViewDialogComponent, {
            width: '400px',
            data: {
              title: 'Task Details',
              content: `Title: ${task.title}\nStatus: ${task.task_status}\nOwning Team: ${task.owner_dept_id || '—'}\nActioned By: ${task.implementor_type || ''} #${task.implementor_id || '—'}\n\n—\nClose this dialog and click the task in the task list to edit.`
            }
          });
        });
      }
    });
  }

  private getEffectiveStatus(task: any, allTasks: any[]): string {
    const actualStatus = (task.task_status || 'DRAFT').toUpperCase();
    if (['COMPLETE', 'CANCELLED', 'FAILED', 'APPROVED'].includes(actualStatus)) {
      return actualStatus;
    }
    const hardDeps = (task.hard_dep_ids || '').split(',').filter(Boolean).map(Number);
    const softDeps = (task.soft_dep_ids || '').split(',').filter(Boolean).map(Number);

    const allHardMet = hardDeps.every((depId: number) => {
      const dep = allTasks.find((t: any) => t.task_id === depId);
      return dep && (dep.task_status || '').toUpperCase() === 'COMPLETE';
    });
    const allSoftMet = softDeps.every((depId: number) => {
      const dep = allTasks.find((t: any) => t.task_id === depId);
      return dep && ['COMPLETE', 'CANCELLED', 'FAILED'].includes((dep.task_status || '').toUpperCase());
    });

    if ((!allHardMet && hardDeps.length > 0) || (!allSoftMet && softDeps.length > 0)) {
      return 'BLOCKED_DEP';
    }
    return actualStatus;
  }

  private getNodeColor(status: string): string {
    switch ((status || '').toUpperCase()) {
      case 'COMPLETE': case 'COMPLETED': return '#4caf50';
      case 'APPROVED': case 'READY': return '#2196F3';
      case 'STARTED': case 'IN_PROGRESS': case 'ACTIVE': return '#7B1FA2';
      case 'FAILED': return '#f44336';
      case 'CANCELLED': return '#9e9e9e';
      case 'BLOCKED_DEP': case 'BLOCKED': return '#ff9800';
      case 'DRAFT': default: return '#E0E0E0';
    }
  }

  private getNodeBorder(status: string): string {
    switch ((status || '').toUpperCase()) {
      case 'COMPLETE': case 'COMPLETED': return '#388e3c';
      case 'APPROVED': case 'READY': return '#1565c0';
      case 'STARTED': case 'IN_PROGRESS': case 'ACTIVE': return '#4A148C';
      case 'FAILED': return '#d32f2f';
      case 'CANCELLED': return '#757575';
      case 'BLOCKED_DEP': case 'BLOCKED': return '#f57c00';
      case 'DRAFT': default: return '#BDBDBD';
    }
  }

  private getNodeTextColor(status: string): string {
    switch ((status || '').toUpperCase()) {
      case 'COMPLETE': case 'COMPLETED':
      case 'STARTED': case 'IN_PROGRESS': case 'ACTIVE':
      case 'CANCELLED':
        return '#FFFFFF';
      default:
        return '#1A1A2E';
    }
  }

  // --- Zoom controls ---

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

  toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    this.cdr.detectChanges();
    setTimeout(() => {
      if (this.cy) {
        this.cy.resize();
        this.cy.fit(undefined, 30);
      }
    }, 350);
  }

  // --- Save/Load positions ---

  async savePositions(): Promise<void> {
    if (!this.cy) return;
    const positions = this.cy.nodes().map((node: any) => ({
      id: node.id(),
      x: Math.round(node.position('x')),
      y: Math.round(node.position('y'))
    }));

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-User-Id': String(this.authService.getCurrentUserId())
      };
      const res = await fetch(`/ords/jit_schema/mcr/v1/map-positions/MCR/${this.data.mcrId}`, {
        method: 'POST',
        headers,
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
