import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'active', pathMatch: 'full' },
  {
    path: 'create',
    loadComponent: () =>
      import('./views/create/create.component').then(m => m.CreateComponent)
  },
  {
    path: 'edit/:id',
    loadComponent: () =>
      import('./views/create/create.component').then(m => m.CreateComponent)
  },
  {
    path: 'active',
    loadComponent: () =>
      import('./views/active/active.component').then(m => m.ActiveComponent)
  },
  {
    path: 'active/:id',
    loadComponent: () =>
      import('./views/active/task-detail/task-detail.component').then(m => m.TaskDetailComponent)
  },
  {
    path: 'active/:id/report',
    loadComponent: () =>
      import('./views/active/report/report.component').then(m => m.ReportComponent)
  },
  {
    path: 'archived',
    loadComponent: () =>
      import('./views/archived/archived.component').then(m => m.ArchivedComponent)
  },
  {
    path: 'admin',
    loadComponent: () =>
      import('./views/admin/admin.component').then(m => m.AdminComponent)
  },
  {
    path: 'models',
    loadComponent: () =>
      import('./views/models/models.component').then(m => m.ModelsComponent)
  },
  {
    path: 'workflows',
    loadComponent: () =>
      import('./views/workflows/workflows.component').then(m => m.WorkflowsComponent)
  }
];
