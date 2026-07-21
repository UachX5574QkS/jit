import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { MCRFormComponent } from '../../components/mcr-form/mcr-form.component';

@Component({
  selector: 'app-create',
  standalone: true,
  imports: [MCRFormComponent],
  template: `
    <div class="view-container">
      <app-mcr-form [editMcrId]="editMcrId" />
    </div>
  `,
  styles: [`.view-container { padding: 24px; }`]
})
export class CreateComponent {
  private readonly route = inject(ActivatedRoute);
  editMcrId: number | null = null;

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    this.editMcrId = id ? Number(id) : null;
  }
}
