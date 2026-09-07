/**
 * The manager-hierarchy resolver (design: "Hierarchy — resolution tests incl.
 * area-manager cutoff and cycle termination", R19).
 *
 * ── What it computes ─────────────────────────────────────────────────────────
 * Given a person, it builds that person's DOWNWARD management hierarchy: the
 * people who record that person as their manager, then recursively the people
 * managed by each of those, until no further reports remain (R19.1). This is
 * the set that "My Team" request filters (R4.3, task 6.6) and Team Statistics
 * (R11, task 8.2) are scoped to.
 *
 * ── Single source of truth for hierarchy shape ───────────────────────────────
 * Every "who is under this manager?" question in the system is answered HERE,
 * so the traversal rules (R19.1–19.4) live behind one seam. The schema owns the
 * relationships — `app_user.manager_id` (a self-FK, migration 0002) and the
 * separate `area_manager` lookup (R19.3, migration 0002) — while this module
 * owns the RULES for walking them. Callers never re-implement the walk; they
 * load a {@link ManagerGraph} and ask {@link resolveDownwardHierarchy}.
 *
 * ── The rules (R19) ───────────────────────────────────────────────────────────
 *   1. Downward, transitively: start from the root's direct reports, then their
 *      reports, and so on until the frontier is empty (R19.1).
 *   2. Area-manager cutoff (R19.2): an area manager's hierarchy starts at
 *      THEMSELVES and does NOT traverse upward to their own manager. Because
 *      this resolver only ever walks DOWNWARD, "does not traverse upward" holds
 *      by construction for the root. The remaining, meaningful reading of the
 *      cutoff for a downward walk is that an area manager is a BOUNDARY: when a
 *      report encountered during traversal is itself an area manager, that
 *      person heads their own hierarchy, so we include them (they are a genuine
 *      report per R19.1) but do NOT descend past them into their sub-tree — the
 *      area-manager designation stops the walk there. This keeps each area
 *      manager's sub-tree owned by that area manager rather than absorbed into
 *      an ancestor's "My Team". The root itself is never treated as its own
 *      cutoff (a boundary only stops traversal when reached AS a report), so
 *      asking for an area manager's own downward team still returns their
 *      reports. This interpretation is applied consistently and is the one the
 *      unit tests pin down.
 *   3. Area-manager designation is read from the separate `area_manager` lookup,
 *      surfaced here as {@link ManagerGraph.areaManagerIds} — never a field on
 *      the user record (R19.3).
 *   4. Cycle guard (R19.4): a `visited` set makes each person be expanded at
 *      most once, so a self-cycle (a → a) or a multi-node cycle (a → b → a) can
 *      never loop forever. Resolution ALWAYS terminates. Real data should be
 *      acyclic, but the guard means malformed data degrades gracefully instead
 *      of hanging.
 *
 * ── Purity / testability ─────────────────────────────────────────────────────
 * The resolver is pure and side-effect free: it operates only on the injected
 * {@link ManagerGraph}, so the unit tests exercise the area-manager cutoff and
 * cycle termination entirely without a database (matching the project's
 * cross-cutting-module test style). The database-backed
 * {@link import('./hierarchy-loader.js').DbManagerGraphLoader} is the separate
 * seam that produces a `ManagerGraph` from parameterised SQL.
 */

/** A person's `app_user.id`. */
export type UserId = number;

/**
 * The manager relationships needed to walk a downward hierarchy, decoupled from
 * how they are sourced. A {@link import('./hierarchy-loader.js').ManagerGraphLoader}
 * produces this from the database; tests build it in memory.
 */
export interface ManagerGraph {
  /**
   * Direct-reports adjacency: `directReports.get(managerId)` is the set of
   * users who record `managerId` as their manager (i.e. `app_user.manager_id`
   * inverted). A manager with no reports may be absent or map to an empty set.
   */
  readonly directReports: ReadonlyMap<UserId, ReadonlySet<UserId>>;
  /**
   * The set of users designated area managers, read from the separate
   * `area_manager` lookup (R19.3). Used as the traversal boundary (R19.2).
   */
  readonly areaManagerIds: ReadonlySet<UserId>;
}

/** Options controlling a downward-hierarchy resolution. */
export interface ResolveOptions {
  /**
   * Whether the root person is included in the returned set. The downward
   * hierarchy per R19.1 is the reports BELOW the root, so this defaults to
   * `false`. Callers that want "this person and everyone under them" (e.g. some
   * statistics scopes) can opt in. Including the root never changes traversal:
   * the root is always expanded regardless of its own area-manager status.
   */
  readonly includeRoot?: boolean;
}

/**
 * Build `rootId`'s downward management hierarchy from `graph` (R19.1).
 *
 * Returns the set of user ids strictly below `rootId` (or including `rootId`
 * when {@link ResolveOptions.includeRoot} is set), applying the area-manager
 * cutoff (R19.2) and guarding against cycles so it always terminates (R19.4).
 *
 * The result is a fresh `Set<UserId>`; the input `graph` is never mutated.
 */
export function resolveDownwardHierarchy(
  rootId: UserId,
  graph: ManagerGraph,
  opts: ResolveOptions = {},
): Set<UserId> {
  const result = new Set<UserId>();

  // `expanded` guards against cycles (R19.4): once we have expanded a person's
  // reports we never expand them again, so a self-loop (a → a) or a longer
  // cycle (a → b → a) cannot spin forever. The root is seeded as expanded so a
  // report that points back at the root terminates cleanly too.
  const expanded = new Set<UserId>([rootId]);

  // BFS frontier of managers whose reports we still need to visit. The root is
  // always expanded (its area-manager status never stops its OWN team, R19.2).
  const frontier: UserId[] = [rootId];

  while (frontier.length > 0) {
    const managerId = frontier.pop() as UserId;
    const reports = graph.directReports.get(managerId);
    if (!reports) {
      continue;
    }
    for (const reportId of reports) {
      // A report is a genuine member of the downward hierarchy (R19.1), so it
      // is always included — even when it is itself an area manager.
      result.add(reportId);

      // Cycle guard: skip anyone already expanded (R19.4).
      if (expanded.has(reportId)) {
        continue;
      }
      // Area-manager cutoff (R19.2): an area-manager report heads their own
      // hierarchy, so we include them (above) but do NOT descend into their
      // sub-tree. Mark them expanded so they are never walked further.
      if (graph.areaManagerIds.has(reportId)) {
        expanded.add(reportId);
        continue;
      }
      expanded.add(reportId);
      frontier.push(reportId);
    }
  }

  // The root is a member of its own hierarchy only when explicitly requested.
  // Remove any self-reference that a cyclic edge may have added, then re-add
  // only if opted in, so the includeRoot contract is exact.
  result.delete(rootId);
  if (opts.includeRoot) {
    result.add(rootId);
  }
  return result;
}
