import { Component, inject } from '@angular/core';
import { ThemeService } from '../../../core/theme/theme.service';

/**
 * Top header bar for the ui-foundations shell.
 *
 * A right-aligned flex row: search → dark-mode toggle → chat → notifications →
 * profile. Its min-height matches the sidebar header so the horizontal border
 * lines line up.
 */
@Component({
  selector: 'app-header',
  imports: [],
  templateUrl: './header.html',
  styleUrl: './header.scss',
})
export class Header {
  protected readonly theme = inject(ThemeService);

  protected toggleTheme(): void {
    this.theme.toggle();
  }
}
