import { Component, EventEmitter, Input, Output } from '@angular/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatCardModule } from '@angular/material/card';

export interface RACIEntry {
  user_id?: number;
  department_id?: number;
  team_id?: number;
  role: 'Accountable' | 'Coordinator' | 'Informed';
  type: 'USER' | 'DEPARTMENT' | 'TEAM';
}

export interface User {
  user_id: number;
  username: string;
  display_name: string;
  email: string;
}

export interface Department {
  department_id: number;
  department_name: string;
}

export interface Team {
  team_id: number;
  team_name: string;
}

@Component({
  selector: 'app-raci-assignment',
  standalone: true,
  imports: [MatFormFieldModule, MatSelectModule, MatCardModule],
  templateUrl: './raci-assignment.component.html',
  styleUrl: './raci-assignment.component.scss'
})
export class RACIAssignmentComponent {
  @Input() users: User[] = [];
  @Input() departments: Department[] = [];
  @Input() teams: Team[] = [];
  @Output() raciChange = new EventEmitter<RACIEntry[]>();

  accountableIds: number[] = [];
  coordinatorIds: number[] = [];
  informedIds: number[] = [];

  onSelectionChange(): void {
    this.raciChange.emit(this.getRACIEntries());
  }

  validate(): boolean {
    return this.accountableIds.length >= 1;
  }

  getRACIEntries(): RACIEntry[] {
    const entries: RACIEntry[] = [];

    for (const userId of this.accountableIds) {
      entries.push({ user_id: userId, role: 'Accountable', type: 'USER' });
    }
    for (const userId of this.coordinatorIds) {
      entries.push({ user_id: userId, role: 'Coordinator', type: 'USER' });
    }
    for (const userId of this.informedIds) {
      entries.push({ user_id: userId, role: 'Informed', type: 'USER' });
    }

    return entries;
  }
}
