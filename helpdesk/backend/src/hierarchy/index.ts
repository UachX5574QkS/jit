/**
 * The manager-hierarchy resolver (design: "Hierarchy — resolution tests incl.
 * area-manager cutoff and cycle termination", R19).
 *
 * Feature code that needs a person's downward management hierarchy — the
 * "My Team" request filter (R4.3, task 6.6) and Team Statistics (R11, task 8.2)
 * — imports the pure {@link resolveDownwardHierarchy} and the {@link ManagerGraph}
 * shape from here, and constructs a {@link DbManagerGraphLoader} to source the
 * relationships from Postgres. The traversal rules (R19.1–19.4), the
 * area-manager cutoff (R19.2), and the cycle guard (R19.4) live behind this one
 * seam.
 */
export type { ManagerGraph, ResolveOptions, UserId } from './hierarchy.js';
export { resolveDownwardHierarchy } from './hierarchy.js';
export type { ManagerGraphLoader } from './hierarchy-loader.js';
export { DbManagerGraphLoader } from './hierarchy-loader.js';
