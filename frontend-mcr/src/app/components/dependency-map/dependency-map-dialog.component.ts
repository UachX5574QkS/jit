import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialog, MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

interface MapNode {
  id: string;
  label: string;
  status: string;
  x: number;
  y: number;
  type: 'root' | 'task';
}

interface MapEdge {
  source: string;
  target: string;
  type: 'hard' | 'soft';
}

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
    MatProgressSpinnerModule
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
        <div class="svg-container">
          <svg [attr.width]="svgWidth" [attr.height]="svgHeight" class="dep-graph">
            <defs>
              <marker id="arrowhead-hard" markerWidth="10" markerHeight="7"
                      refX="10" refY="3.5" orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" fill="#666" />
              </marker>
              <marker id="arrowhead-soft" markerWidth="10" markerHeight="7"
                      refX="10" refY="3.5" orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" fill="#999" />
              </marker>
            </defs>

            <!-- Edges -->
            @for (edge of edges; track edge.source + edge.target) {
              <line
                [attr.x1]="getNode(edge.source)?.x"
                [attr.y1]="getNode(edge.source)?.y"
                [attr.x2]="getNode(edge.target)?.x"
                [attr.y2]="getNode(edge.target)?.y"
                [attr.stroke]="edge.type === 'hard' ? '#666' : '#999'"
                [attr.stroke-width]="edge.type === 'hard' ? 2 : 1.5"
                [attr.stroke-dasharray]="edge.type === 'soft' ? '6,4' : 'none'"
                [attr.marker-end]="'url(#arrowhead-' + edge.type + ')'"
              />
            }

            <!-- Nodes -->
            @for (node of nodes; track node.id) {
              <g [attr.transform]="'translate(' + node.x + ',' + node.y + ')'" class="node-group" (click)="onNodeClick(node)">
                <rect
                  [attr.x]="-50"
                  [attr.y]="-18"
                  width="100"
                  height="36"
                  rx="8" ry="8"
                  [attr.fill]="getNodeColor(node.status)"
                  [attr.stroke]="getNodeStroke(node.status)"
                  stroke-width="2"
                  class="node-rect"
                />
                <text
                  text-anchor="middle"
                  dy="5"
                  [attr.font-size]="node.type === 'root' ? '11' : '10'"
                  [attr.fill]="node.status.toUpperCase() === 'CANCELLED' ? 'white' : 'black'"
                  font-weight="500">
                  {{ truncateLabel(node.label) }}
                </text>
                <title>{{ node.label }} ({{ node.status }})</title>
              </g>
            }
          </svg>
        </div>

        <!-- Legend -->
        <div class="legend">
          <div class="legend-item">
            <svg width="24" height="12"><line x1="0" y1="6" x2="24" y2="6" stroke="#666" stroke-width="2" /></svg>
            <span>Hard dependency</span>
          </div>
          <div class="legend-item">
            <svg width="24" height="12"><line x1="0" y1="6" x2="24" y2="6" stroke="#999" stroke-width="1.5" stroke-dasharray="6,4" /></svg>
            <span>Soft dependency</span>
          </div>
          <div class="legend-item"><span class="dot" style="background:#BDBDBD"></span> Not Active</div>
          <div class="legend-item"><span class="dot" style="background:#ff9800"></span> Blocked</div>
          <div class="legend-item"><span class="dot" style="background:#2196F3"></span> Ready</div>
          <div class="legend-item"><span class="dot" style="background:#FFC107"></span> Started</div>
          <div class="legend-item"><span class="dot" style="background:#4caf50"></span> Complete</div>
          <div class="legend-item"><span class="dot" style="background:#424242"></span> Cancelled</div>
          <div class="legend-item"><span class="dot" style="background:#f44336"></span> Failed</div>
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Close</button>
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
    .svg-container {
      overflow: auto;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      background: #fafafa;
    }
    .dep-graph {
      display: block;
    }
    .node-rect {
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .node-rect:hover {
      opacity: 0.8;
    }
    .node-group {
      cursor: pointer;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      padding: 12px 0 0;
      font-size: 12px;
      color: rgba(0, 0, 0, 0.7);
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

  nodes: MapNode[] = [];
  edges: MapEdge[] = [];
  loading = true;
  error: string | null = null;
  svgWidth = 700;
  svgHeight = 500;
  taskData: any[] = [];
  private mcrActive = false;

  ngOnInit(): void {
    this.loadDependencyMap();
  }

  private async loadDependencyMap(): Promise<void> {
    this.loading = true;
    this.cdr.detectChanges();

    try {
      // Fetch MCR status
      const mcrRes = await fetch(`/ords/jit_schema/mcr/v1/requests/${this.data.mcrId}`);
      if (mcrRes.ok) {
        const mcrData = await mcrRes.json();
        this.mcrActive = (mcrData?.mcr_status || '').toUpperCase() === 'ACTIVE';
      }

      const res = await fetch(`/ords/jit_schema/mcr/v1/tasks/mcr/${this.data.mcrId}`);
      if (!res.ok) {
        this.error = 'Failed to load dependency map.';
        this.loading = false;
        this.cdr.detectChanges();
        return;
      }
      const data = await res.json();
      const tasks = data?.items ?? (Array.isArray(data) ? data : []);
      this.buildGraph(tasks);
    } catch {
      this.error = 'Failed to load dependency map.';
    }

    this.loading = false;
    this.cdr.detectChanges();
  }

  private buildGraph(tasks: any[]): void {
    this.taskData = tasks;
    const mcrTitle = this.data.mcrNumber || 'MCR';

    // Create root node at top center
    const rootNode: MapNode = {
      id: 'root',
      label: mcrTitle,
      status: 'root',
      x: this.svgWidth / 2,
      y: 50,
      type: 'root'
    };
    this.nodes = [rootNode];

    if (tasks.length === 0) {
      return;
    }

    // Layout tasks in rows below root
    const cols = Math.min(tasks.length, 4);
    const rows = Math.ceil(tasks.length / cols);
    const xSpacing = this.svgWidth / (cols + 1);
    const yStart = 140;
    const ySpacing = 100;

    // Adjust SVG height if needed
    this.svgHeight = Math.max(500, yStart + rows * ySpacing + 80);

    tasks.forEach((task: any, i: number) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const x = xSpacing * (col + 1);
      const y = yStart + row * ySpacing;

      this.nodes.push({
        id: `task-${task.task_id}`,
        label: task.title || `Task ${task.task_seq || i + 1}`,
        status: this.mcrActive
          ? this.getEffectiveStatus(task, tasks)
          : 'DRAFT',
        x,
        y,
        type: 'task'
      });
    });

    // Build edges from dependency data (hard_dep_ids / soft_dep_ids are comma-separated strings)
    tasks.forEach((task: any) => {
      const hardDeps = (task.hard_dep_ids || '').split(',').filter(Boolean).map(Number);
      const softDeps = (task.soft_dep_ids || '').split(',').filter(Boolean).map(Number);

      hardDeps.forEach((depId: number) => {
        this.edges.push({ source: `task-${depId}`, target: `task-${task.task_id}`, type: 'hard' });
      });
      softDeps.forEach((depId: number) => {
        this.edges.push({ source: `task-${depId}`, target: `task-${task.task_id}`, type: 'soft' });
      });

      // Connect to root only if no incoming dependencies
      if (hardDeps.length === 0 && softDeps.length === 0) {
        this.edges.push({ source: 'root', target: `task-${task.task_id}`, type: 'hard' });
      }
    });
  }

  private getEffectiveStatus(task: any, allTasks: any[]): string {
    const actualStatus = (task.task_status || 'DRAFT').toUpperCase();
    // If already terminal, use actual status
    if (['COMPLETE', 'CANCELLED', 'FAILED', 'APPROVED'].includes(actualStatus)) {
      return actualStatus;
    }
    // Check if dependencies are met
    const hardDeps = (task.hard_dep_ids || '').split(',').filter(Boolean).map(Number);
    const softDeps = (task.soft_dep_ids || '').split(',').filter(Boolean).map(Number);
    
    const allHardMet = hardDeps.every((depId: number) => {
      const dep = allTasks.find((t: any) => t.task_id === depId);
      return dep && dep.task_status === 'Complete';
    });
    const allSoftMet = softDeps.every((depId: number) => {
      const dep = allTasks.find((t: any) => t.task_id === depId);
      return dep && ['Complete', 'Cancelled', 'Failed'].includes(dep.task_status);
    });
    
    if ((!allHardMet && hardDeps.length > 0) || (!allSoftMet && softDeps.length > 0)) {
      return 'BLOCKED';
    }
    return actualStatus;
  }

  onNodeClick(node: MapNode): void {
    if (node.type === 'root') return;
    const task = this.taskData.find((t: any) => `task-${t.task_id}` === node.id);
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
  }

  getNode(id: string): MapNode | undefined {
    return this.nodes.find(n => n.id === id);
  }

  getNodeColor(status: string): string {
    switch (status.toUpperCase()) {
      case 'READY': return '#2196F3';        // Blue - ready to start
      case 'APPROVED': return '#2196F3';     // Blue - approved/ready
      case 'COMPLETE': case 'COMPLETED': return '#4caf50';  // Green
      case 'CANCELLED': return '#424242';    // Dark Gray
      case 'FAILED': return '#f44336';       // Red
      case 'BLOCKED': return '#ff9800';      // Orange
      case 'IN_PROGRESS': case 'ACTIVE': return '#FFC107'; // Yellow - started
      case 'ROOT': return '#9e9e9e';         // Light Grey for MCR root
      default: return '#BDBDBD';             // Light Grey - not active
    }
  }

  getNodeStroke(status: string): string {
    switch (status.toUpperCase()) {
      case 'READY': case 'APPROVED': return '#1565c0';
      case 'COMPLETE': case 'COMPLETED': return '#388e3c';
      case 'CANCELLED': return '#212121';
      case 'FAILED': return '#d32f2f';
      case 'BLOCKED': return '#f57c00';
      case 'IN_PROGRESS': case 'ACTIVE': return '#F9A825';
      case 'ROOT': return '#757575';
      default: return '#9E9E9E';
    }
  }

  truncateLabel(label: string): string {
    return label.length > 14 ? label.substring(0, 12) + '…' : label;
  }
}
