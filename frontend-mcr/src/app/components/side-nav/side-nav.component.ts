import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

interface NavItem {
  label: string;
  icon: string;
  route: string;
}

@Component({
  selector: 'app-side-nav',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, MatIconModule],
  templateUrl: './side-nav.component.html',
  styleUrl: './side-nav.component.scss'
})
export class SideNavComponent {
  readonly navItems: NavItem[] = [
    { label: 'Create', icon: 'add_circle', route: '/create' },
    { label: 'Active', icon: 'play_circle', route: '/active' },
    { label: 'Archived', icon: 'archive', route: '/archived' },
    { label: 'Admin', icon: 'settings', route: '/admin' }
  ];
}
