import type { ManagerGraph, UserId } from './hierarchy.js';
import type { Queryable } from '../db/query.js';
import { query } from '../db/query.js';
import { pool } from '../db/pool.js';

/**
 * Loads the manager relationships as a {@link ManagerGraph} (design: data model
 * "Identity & org"; R19).
 *
 * The loader is the boundary between the pure hierarchy resolver and the
 * database. It is expressed as an interface so tests can inject an in-memory
 * fake (keeping hierarchy unit tests database-free, matching the project's test
 * style) and so a future deployment could source the relationships differently
 * while still producing the same `ManagerGraph` shape the resolver consumes.
 */
export interface ManagerGraphLoader {
  /**
   * Load the full manager graph: the direct-reports adjacency (from
   * `app_user.manager_id`) and the set of area managers (from the separate
   * `area_manager` lookup). Returns a graph the pure resolver can walk.
   */
  load(): Promise<ManagerGraph>;
}

/** Row shape for the manager-edge read (`app_user.manager_id` inverted). */
interface ManagerEdgeRow {
  readonly user_id: UserId;
  readonly manager_id: UserId;
}

/** Row shape for the area-manager lookup read. */
interface AreaManagerRow {
  readonly user_id: UserId;
}

/**
 * Postgres-backed {@link ManagerGraphLoader}. Reads the manager self-FK and the
 * `area_manager` lookup through the parameterised data-access layer (R22.4).
 *
 * The whole graph is loaded in two set-based reads rather than one query per
 * traversal step: hierarchies are small and the resolver runs in memory, so a
 * single snapshot avoids N+1 round-trips and gives the resolver a consistent
 * view. Neither statement interpolates any value into SQL (there are no
 * bound parameters here — the reads are unfiltered snapshots of trusted,
 * code-controlled tables).
 */
export class DbManagerGraphLoader implements ManagerGraphLoader {
  constructor(private readonly db: Queryable = pool) {}

  async load(): Promise<ManagerGraph> {
    // Manager edges: every user that has a manager. NULL manager_id (top of a
    // chain) is excluded — such users are simply not reports of anyone.
    const [edgeRows, areaRows] = await Promise.all([
      query<ManagerEdgeRow>(
        `SELECT id AS user_id, manager_id
           FROM app_user
          WHERE manager_id IS NOT NULL`,
        [],
        this.db,
      ),
      query<AreaManagerRow>(
        `SELECT user_id FROM area_manager`,
        [],
        this.db,
      ),
    ]);

    // Invert the edges into a direct-reports adjacency keyed by manager.
    const directReports = new Map<UserId, Set<UserId>>();
    for (const { user_id, manager_id } of edgeRows) {
      let reports = directReports.get(manager_id);
      if (!reports) {
        reports = new Set<UserId>();
        directReports.set(manager_id, reports);
      }
      reports.add(user_id);
    }

    const areaManagerIds = new Set<UserId>(areaRows.map((r) => r.user_id));

    return { directReports, areaManagerIds };
  }
}
