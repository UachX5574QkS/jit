import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Footer } from '../footer/footer';
import { Header } from '../header/header';
import { Sidebar } from '../sidebar/sidebar';

/**
 * The ui-foundations application shell.
 *
 * Composes the fixed 108px sidebar, the top header bar, a centred content
 * column (max-width ~1200px) with `margin-left: 108px`, and the footer. On
 * mobile the sidebar collapses behind a toggle button and the content margin
 * is removed.
 */
@Component({
  selector: 'app-layout-shell',
  imports: [RouterOutlet, Sidebar, Header, Footer],
  templateUrl: './layout-shell.html',
  styleUrl: './layout-shell.scss',
})
export class LayoutShell {
  /** Whether the sidebar is revealed on small screens. */
  protected readonly sidebarOpen = signal(false);

  protected toggleSidebar(): void {
    this.sidebarOpen.update((open) => !open);
  }

  protected closeSidebar(): void {
    this.sidebarOpen.set(false);
  }
}
