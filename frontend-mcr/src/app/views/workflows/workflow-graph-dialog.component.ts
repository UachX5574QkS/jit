import {
  Component,
  OnInit,
  inject,
  ChangeDetectorRef,
  ElementRef,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';

export interface WorkflowGraphDialogData {
  workflowId: number;
  workflowName: string;
  typeName: string;
}

@Component({
  selector: 'app-workflow-graph-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule
  ],
  template: `
    <h2 mat-dialog-title>{{ data.workflowName }} — {{ data.typeName }}</h2>
    <mat-dialog-content class="graph-content">
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
        </div>
        <div class="cytoscape-container" [class.fullscreen]="fullscreen" #cyContainer></div>
        <div class="legend">
          <div class="legend-item"><span class="dot" style="background:#9e9e9e"></span> Initial</div>
          <div class="legend-item"><span class="dot" style="background:#5A287D"></span> Active</div>
          <div class="legend-item"><span class="dot" style="background:#1A1A2E"></span> Terminal</div>
          <div class="legend-item">
            <svg width="30" height="12"><line x1="0" y1="6" x2="30" y2="6" stroke="#5A287D" stroke-width="2" /></svg>
            <span>Manual</span>
          </div>
          <div class="legend-item">
            <svg width="30" height="12"><line x1="0" y1="6" x2="30" y2="6" stroke="#23A656" stroke-width="2" stroke-dasharray="5,3" /></svg>
            <span>Auto</span>
          </div>
          <div class="legend-item">
            <svg width="30" height="12"><line x1="0" y1="6" x2="30" y2="6" stroke="#F2A900" stroke-width="2" stroke-dasharray="2,3" /></svg>
            <span>System</span>
          </div>
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-stroked-button mat-dialog-close>Close</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .graph-content {
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
      color: #D5281B;
      text-align: center;
      padding: 24px;
    }
    .map-toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 8px;
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
export class WorkflowGraphDialogComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<WorkflowGraphDialogComponent>);
  readonly data: WorkflowGraphDialogData = inject(MAT_DIALOG_DATA);
  private readonly cdr = inject(ChangeDetectorRef);

  @ViewChild('cyContainer', { static: false }) cyContainer!: ElementRef;
  private cy: any = null;

  loading = true;
  error: string | null = null;
  fullscreen = false;

  ngOnInit(): void {
    this.loadGraph();
  }

  private async loadGraph(): Promise<void> {
    this.loading = true;
    this.cdr.detectChanges();

    try {
      const res = await fetch(`/ords/jit_schema/mcr/v1/workflows/graph/${this.data.workflowId}`);
      if (!res.ok) {
        this.error = 'Failed to load workflow graph.';
        this.loading = false;
        this.cdr.detectChanges();
        return;
      }

      const graphData = await res.json();
      this.loading = false;
      this.cdr.detectChanges();

      setTimeout(() => this.renderGraph(graphData), 100);
    } catch {
      this.error = 'Failed to load workflow graph.';
      this.loading = false;
      this.cdr.detectChanges();
    }
  }

  private renderGraph(graphData: { nodes: any[]; edges: any[] }): void {
    if (!this.cyContainer?.nativeElement) return;

    // Register dagre layout
    if (!(cytoscape as any).extensions?.layout?.dagre) {
      cytoscape.use(dagre);
    }

    const elements: any[] = [];

    // Add nodes
    (graphData.nodes || []).forEach((node: any) => {
      elements.push({
        data: {
          id: node.id,
          label: node.label,
          state_type: node.state_type,
          color: node.color
        }
      });
    });

    // Add edges
    (graphData.edges || []).forEach((edge: any) => {
      elements.push({
        data: {
          source: edge.source,
          target: edge.target,
          label: edge.label,
          trigger_type: edge.trigger_type
        }
      });
    });

    if (this.cy) {
      this.cy.destroy();
    }

    this.cy = cytoscape({
      container: this.cyContainer.nativeElement,
      elements,
      layout: {
        name: 'dagre',
        rankDir: 'LR',
        nodeSep: 60,
        rankSep: 100,
        edgeSep: 30,
        padding: 40
      } as any,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': (ele: any) => this.getNodeColor(ele.data('state_type'), ele.data('color')),
            'border-color': (ele: any) => this.getNodeBorder(ele.data('state_type')),
            'border-width': 2,
            'label': 'data(label)',
            'color': (ele: any) => this.getNodeTextColor(ele.data('state_type')),
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '11px',
            'font-weight': 'bold',
            'width': 130,
            'height': 36,
            'shape': 'round-rectangle',
            'text-max-width': '110px',
            'text-wrap': 'ellipsis'
          }
        },
        {
          selector: 'edge[trigger_type = "manual"]',
          style: {
            'line-color': '#5A287D',
            'target-arrow-color': '#5A287D',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'width': 2,
            'arrow-scale': 0.8,
            'label': 'data(label)',
            'font-size': '9px',
            'text-rotation': 'autorotate',
            'text-margin-y': -10,
            'color': '#5B5B6E'
          }
        },
        {
          selector: 'edge[trigger_type = "auto"]',
          style: {
            'line-color': '#23A656',
            'target-arrow-color': '#23A656',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'width': 2,
            'line-style': 'dashed',
            'line-dash-pattern': [6, 4],
            'arrow-scale': 0.8,
            'label': 'data(label)',
            'font-size': '9px',
            'text-rotation': 'autorotate',
            'text-margin-y': -10,
            'color': '#5B5B6E'
          }
        },
        {
          selector: 'edge[trigger_type = "system"]',
          style: {
            'line-color': '#F2A900',
            'target-arrow-color': '#F2A900',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'width': 2,
            'line-style': 'dotted',
            'line-dash-pattern': [2, 4],
            'arrow-scale': 0.8,
            'label': 'data(label)',
            'font-size': '9px',
            'text-rotation': 'autorotate',
            'text-margin-y': -10,
            'color': '#5B5B6E'
          }
        }
      ],
      userZoomingEnabled: false,
      userPanningEnabled: true,
      boxSelectionEnabled: false
    });

    this.cy.fit(undefined, 30);
  }

  private getNodeColor(stateType: string, color: string): string {
    if (color) return color;
    switch (stateType) {
      case 'initial': return '#9e9e9e';
      case 'active': return '#5A287D';
      case 'terminal': return '#1A1A2E';
      default: return '#E0E0E0';
    }
  }

  private getNodeBorder(stateType: string): string {
    switch (stateType) {
      case 'initial': return '#757575';
      case 'active': return '#4A148C';
      case 'terminal': return '#000000';
      default: return '#BDBDBD';
    }
  }

  private getNodeTextColor(stateType: string): string {
    switch (stateType) {
      case 'initial': return '#1A1A2E';
      case 'active': return '#FFFFFF';
      case 'terminal': return '#FFFFFF';
      default: return '#1A1A2E';
    }
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
}
