import { Component, Input, OnInit, inject, ElementRef, ViewChild, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TaskService } from '../../services/task.service';

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

@Component({
  selector: 'app-dependency-map',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule
  ],
  template: `
    <h2 mat-dialog-title>Dependency Map</h2>
    <mat-dialog-content class="map-content">
      @if (loading) {
        <div class="loading-container">
          <mat-spinner diameter="40"></mat-spinner>
        </div>
      } @else if (error) {
        <p class="error-text">{{ error }}</p>
      } @else {
        <div class="svg-container" #svgContainer>
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
              <g [attr.transform]="'translate(' + node.x + ',' + node.y + ')'">
                <circle
                  [attr.r]="node.type === 'root' ? 28 : 22"
                  [attr.fill]="getNodeColor(node.status)"
                  [attr.stroke]="getNodeStroke(node.status)"
                  stroke-width="2"
                  class="node-circle"
                />
                <text
                  text-anchor="middle"
                  dy="4"
                  [attr.font-size]="node.type === 'root' ? '11' : '10'"
                  fill="white"
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
          <div class="legend-item"><span class="dot" style="background:#4caf50"></span> Ready/Complete</div>
          <div class="legend-item"><span class="dot" style="background:#9e9e9e"></span> Cancelled</div>
          <div class="legend-item"><span class="dot" style="background:#f44336"></span> Failed</div>
          <div class="legend-item"><span class="dot" style="background:#ff9800"></span> Blocked</div>
          <div class="legend-item"><span class="dot" style="background:#1976d2"></span> In Progress</div>
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
    .node-circle {
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .node-circle:hover {
      opacity: 0.8;
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
export class DependencyMapComponent implements OnInit {
  private readonly taskService = inject(TaskService);
  private readonly dialogRef = inject(MatDialogRef<DependencyMapComponent>);
  private readonly data: { mcrId: number } = inject(MAT_DIALOG_DATA);

  nodes: MapNode[] = [];
  edges: MapEdge[] = [];
  loading = true;
  error: string | null = null;
  svgWidth = 700;
  svgHeight = 500;

  ngOnInit(): void {
    this.loadDependencyMap();
  }

  private loadDependencyMap(): void {
    this.taskService.getDependencyMap(this.data.mcrId).subscribe({
      next: (data) => {
        this.buildGraph(data);
        this.loading = false;
      },
      error: (err) => {
        this.error = 'Failed to load dependency map.';
        this.loading = false;
      }
    });
  }

  private buildGraph(data: any): void {
    const tasks: any[] = data.tasks || data.items || [];
    const mcrTitle = data.mcr_title || 'MCR';

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
        status: (task.status || 'DRAFT').toUpperCase(),
        x,
        y,
        type: 'task'
      });

      // Edge from root to task
      this.edges.push({
        source: 'root',
        target: `task-${task.task_id}`,
        type: 'hard'
      });

      // Hard dependencies
      if (task.hard_dependencies) {
        task.hard_dependencies.forEach((dep: any) => {
          this.edges.push({
            source: `task-${dep.depends_on_task_id || dep}`,
            target: `task-${task.task_id}`,
            type: 'hard'
          });
        });
      }

      // Soft dependencies
      if (task.soft_dependencies) {
        task.soft_dependencies.forEach((dep: any) => {
          this.edges.push({
            source: `task-${dep.depends_on_task_id || dep}`,
            target: `task-${task.task_id}`,
            type: 'soft'
          });
        });
      }
    });
  }

  getNode(id: string): MapNode | undefined {
    return this.nodes.find(n => n.id === id);
  }

  getNodeColor(status: string): string {
    switch (status.toUpperCase()) {
      case 'READY':
      case 'COMPLETE':
      case 'COMPLETED':
        return '#4caf50';
      case 'CANCELLED':
        return '#9e9e9e';
      case 'FAILED':
        return '#f44336';
      case 'BLOCKED':
        return '#ff9800';
      case 'IN_PROGRESS':
      case 'IN PROGRESS':
        return '#1976d2';
      case 'ROOT':
        return '#1976d2';
      default:
        return '#78909c';
    }
  }

  getNodeStroke(status: string): string {
    switch (status.toUpperCase()) {
      case 'READY':
      case 'COMPLETE':
      case 'COMPLETED':
        return '#388e3c';
      case 'CANCELLED':
        return '#757575';
      case 'FAILED':
        return '#d32f2f';
      case 'BLOCKED':
        return '#f57c00';
      case 'IN_PROGRESS':
      case 'IN PROGRESS':
        return '#1565c0';
      case 'ROOT':
        return '#1565c0';
      default:
        return '#546e7a';
    }
  }

  truncateLabel(label: string): string {
    return label.length > 12 ? label.substring(0, 10) + '…' : label;
  }
}
