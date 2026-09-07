import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './core/theme/theme.service';

/**
 * The application root. It renders a single `<router-outlet>` so the router
 * chooses between the login screen (no shell, R1.1) and the ui-foundations
 * shell that wraps the authenticated app (R1.8). The theme service is
 * instantiated here so the persisted dark-mode preference is applied at
 * startup regardless of the active route.
 */
@Component({
  imports: [RouterOutlet],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  // Instantiate the theme service so the persisted theme is applied at startup.
  private readonly theme = inject(ThemeService);
}
