import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { CurrentUserService } from '../../core/auth/current-user.service';

/**
 * The authenticated landing page shown at the app root inside the ui-foundations
 * shell. After a successful login the app navigates here (R1.3); the sidebar
 * beside it renders the menu from the user's role superset (R1.8).
 *
 * It presents the UK-English greeting from the UI Design Specification —
 * "Good [Morning|Afternoon|Evening], [Name]" using the browser's local time —
 * and a short note. Feature landing screens (New, Requests, etc.) are added by
 * later tasks; this keeps the post-login destination meaningful in the interim.
 */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class Home {
  private readonly currentUser = inject(CurrentUserService);

  /** First name (or full display name) for the greeting. */
  protected readonly name = computed(() => {
    const display = this.currentUser.user()?.displayName ?? '';
    return display.split(' ')[0] || display;
  });

  /** UK-English time-of-day greeting from the browser's local clock. */
  protected readonly greeting = computed(() => `${periodGreeting(new Date())}, ${this.name()}`);
}

/**
 * The UK-English greeting period for a given local time (UI spec: Greeting
 * Logic): 05:00–11:59 Morning, 12:00–17:59 Afternoon, otherwise Evening.
 */
export function periodGreeting(now: Date): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) {
    return 'Good Morning';
  }
  if (hour >= 12 && hour < 18) {
    return 'Good Afternoon';
  }
  return 'Good Evening';
}
