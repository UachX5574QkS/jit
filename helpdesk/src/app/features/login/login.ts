import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService, type DirectoryUser } from '../../core/auth/auth.service';
import { ApiError } from '../../core/http/api-error';

/**
 * The login screen (design: "Auth & identity", R1.1–R1.4).
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 * Presented when no user is authenticated (R1.1). It prompts for a username and
 * password. In development the username field is a DROP-DOWN populated from
 * `GET /api/auth/users`, listing each created person as
 * "`<username>` `<firstname>` (`<role>`) `<surname>`" so a developer can pick
 * who to log in as (R1.2) — all seeded accounts share the password "password1".
 *
 * On submit it calls {@link AuthService.login}, which establishes the session
 * (the auth interceptor's `withCredentials` carries the cookie) and loads the
 * resolved {@link CurrentUser} through the single identity abstraction (R1.3,
 * R1.7). It then navigates to the app root, where the sidebar renders the menu
 * from the user's role superset (R1.8). Invalid credentials are rejected
 * without a session (R1.4) and shown as an inline error.
 *
 * Rendered OUTSIDE the ui-foundations shell (its own route), so there is no
 * sidebar/header before authentication.
 */
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** The chosen/entered username. */
  protected readonly username = signal('');
  /** The entered password. */
  protected readonly password = signal('');

  /** The dev-login drop-down directory (empty until loaded / outside dev). */
  protected readonly directory = signal<DirectoryUser[]>([]);
  /** True while the login request is in flight. */
  protected readonly submitting = signal(false);
  /** An inline error message to display (invalid credentials, etc.). */
  protected readonly error = signal<string | null>(null);

  constructor() {
    // Populate the development login drop-down (R1.2). If the endpoint is not
    // available (e.g. non-dev backend), fall back silently to the text field.
    this.auth.listDirectory().subscribe({
      next: (users) => this.directory.set(users),
      error: () => this.directory.set([]),
    });
  }

  /** Whether the dev drop-down should be shown (any directory entries loaded). */
  protected hasDirectory(): boolean {
    return this.directory().length > 0;
  }

  protected onUsernameChange(value: string): void {
    this.username.set(value);
    this.error.set(null);
  }

  protected onPasswordChange(value: string): void {
    this.password.set(value);
    this.error.set(null);
  }

  /** Whether the form can be submitted (both fields present, not in flight). */
  protected canSubmit(): boolean {
    return (
      !this.submitting() && this.username().trim() !== '' && this.password() !== ''
    );
  }

  /**
   * Submit the credentials: establish the session, resolve the current user,
   * then navigate into the app (R1.3). Invalid credentials surface an inline
   * message and leave the user on the login screen (R1.4).
   */
  protected submit(): void {
    if (!this.canSubmit()) {
      return;
    }
    this.submitting.set(true);
    this.error.set(null);

    this.auth.login({ username: this.username().trim(), password: this.password() }).subscribe({
      next: () => {
        this.submitting.set(false);
        void this.router.navigateByUrl('/');
      },
      error: (err: unknown) => {
        this.submitting.set(false);
        this.error.set(this.messageFor(err));
      },
    });
  }

  /**
   * Map a login failure to a user-facing message (R1.4). Handles both the
   * mapped {@link ApiError} (normal path, via the error interceptor) and a raw
   * {@link HttpErrorResponse} (defensive, e.g. if the interceptor is absent) so
   * a 401 always reads as "Invalid username or password."
   */
  private messageFor(err: unknown): string {
    if (err instanceof ApiError) {
      // A 401/FORBIDDEN from login means bad credentials; the backend uses an
      // identical response whether the username exists or not.
      if (err.status === 401 || err.code === 'FORBIDDEN') {
        return 'Invalid username or password.';
      }
      if (err.code === 'NETWORK_ERROR') {
        return 'Unable to reach the server. Please try again.';
      }
      return err.message;
    }
    if (err instanceof HttpErrorResponse) {
      if (err.status === 401 || err.status === 403) {
        return 'Invalid username or password.';
      }
      if (err.status === 0) {
        return 'Unable to reach the server. Please try again.';
      }
    }
    return 'Unable to log in. Please try again.';
  }
}
