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

/**
 * Row shape for the manager-edge read (`app_user.manager_id` inverted). The id
 * columns are bigint, which node-postgres returns as strings; they are coerced
 * to numbers when the graph is built so the `UserId = number` contract holds.
 */
interface ManagerEdgeRow {
  readonly user_id: string | number;
  readonly manager_id: string | number;
}

/** Row shape for the area-manager lookup read (bigint id -> string at runtime). */
interface AreaManagerRow {
  readonly user_id: string | number;
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

    // Invert the edges into a direct-reports adjacency keyed by manager, and
    // record each user's manager for the "My Team" root lookup (R4.3).
    const directReports = new Map<UserId, Set<UserId>>();
    const managerOf = new Map<UserId, UserId>();
    for (const edge of edgeRows) {
      // Coerce bigint-as-string ids to numbers so the graph keys/values match
      // the numeric UserId the resolver is called with (a string key would make
      // directReports.get(numericId) miss and yield an empty hierarchy).
      const userId = Number(edge.user_id);
      const managerId = Number(edge.manager_id);
      let reports = directReports.get(managerId);
      if (!reports) {
        reports = new Set<UserId>();
        directReports.set(managerId, reports);
      }
      reports.add(userId);
      managerOf.set(userId, managerId);
    }

    const areaManagerIds = new Set<UserId>(areaRows.map((r) => Number(r.user_id)));

    return { directReports, managerOf, areaManagerIds };
  }
}
