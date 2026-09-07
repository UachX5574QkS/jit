import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CurrentUserService } from '../../core/auth/current-user.service';

/**
 * One tile in the Administer landing (design: "Administer — admin tiles +
 * team-leader tiles"; R13, R14, R15, R16).
 */
interface AdminTile {
  readonly path: string;
  readonly label: string;
  readonly description: string;
  /** Icon key selecting one of the inline SVGs in the template. */
  readonly icon: 'teams' | 'dataPoints' | 'membership' | 'tasks';
  /** When true, only shown to administrators (Tool-Administrator tiles, R13.1). */
  readonly adminOnly?: boolean;
  /** When true, only shown to team leaders (Team-Leader tiles, R15.1). */
  readonly leaderOnly?: boolean;
}

/**
 * All administer tiles in display order. Visibility per tile is decided from the
 * current user's role superset by {@link AdministerHome.tiles}.
 *
 *   • Teams / Data Points — Tool-Administrator tiles, administrators only
 *     (R13.1, R14). Implemented by this task (14.1).
 *   • Membership / Tasks   — Team-Leader tiles, leaders only (R15.1, R16.1).
 *     Implemented by this task (14.2): Team Membership manages the details and
 *     membership of a team the current user leads, and Tasks manages that
 *     team's tasks (create/new-version/retire with version pinning).
 */
const TILES: readonly AdminTile[] = [
  {
    path: '/administer/teams',
    label: 'Teams',
    description: 'Create teams, change a team’s leader, and close teams.',
    icon: 'teams',
    adminOnly: true,
  },
  {
    path: '/administer/data-points',
    label: 'Data Points',
    description: 'Maintain the catalogue of reusable field definitions.',
    icon: 'dataPoints',
    adminOnly: true,
  },
  {
    path: '/administer/teams-membership',
    label: 'Team Membership',
    description: 'Update the details and membership of a team you lead.',
    icon: 'membership',
    leaderOnly: true,
  },
  {
    path: '/administer/tasks',
    label: 'Tasks',
    description: 'Create tasks, publish new versions, and retire tasks for your teams.',
    icon: 'tasks',
    leaderOnly: true,
  },
];

/**
 * The Administer landing shown at `/administer` inside the ui-foundations shell
 * (design: "Administer — admin tiles + team-leader tiles"; R13.1, R14, R15.1,
 * R16.1). It presents the areas the current user may manage as clickable tiles.
 *
 * ── Role-scoped tiles (R13.1, R15.1) ─────────────────────────────────────────
 * The route is reachable by administrators OR team leaders (the shared
 * `administerGuard`), but each tile is shown only to the role it belongs to,
 * read from the additive role superset (R1.8): the Tool-Administrator tiles
 * (Teams, Data Points) appear only for administrators (R13.1), and the
 * Team-Leader tiles (added by task 14.2) only for team leaders (R15.1). A person
 * who is both sees the union. Tile visibility here is UX only — every admin
 * endpoint is enforced server-side (R1.8).
 */
@Component({
  selector: 'app-administer-home',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './administer-home.html',
  styleUrl: './administer-home.scss',
})
export class AdministerHome {
  private readonly currentUser = inject(CurrentUserService);

  /** The tiles the current user may see, filtered by their role superset (R1.8). */
  protected readonly tiles = computed<AdminTile[]>(() => {
    const isAdmin = this.currentUser.hasRole('ADMINISTRATOR');
    const isLeader = this.currentUser.hasRole('TEAM_LEADER');
    return TILES.filter((tile) => {
      if (tile.adminOnly) {
        return isAdmin;
      }
      if (tile.leaderOnly) {
        return isLeader;
      }
      return true;
    });
  });
}
