import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDownwardHierarchy,
  type ManagerGraph,
  type UserId,
} from './hierarchy.js';

/**
 * DB-free unit tests for the pure manager-hierarchy resolver (R19), matching the
 * node:test + node:assert/strict, injectable/pure style of the other
 * cross-cutting modules. They pin down the transitive downward walk (R19.1), the
 * area-manager cutoff (R19.2), and — the safety-critical part — cycle
 * termination for both a self-cycle and a multi-node cycle (R19.4).
 *
 * The resolver operates only on an injected {@link ManagerGraph}, so no database
 * is involved.
 */

/**
 * Build a {@link ManagerGraph} from a plain manager-edge map (`userId ->
 * managerId`) and an optional set of area managers. This mirrors what the
 * DB loader produces (it inverts `app_user.manager_id`), keeping the tests
 * expressed in the natural "who reports to whom" direction.
 */
function graphOf(
  managerOf: Record<number, number>,
  areaManagers: readonly number[] = [],
): ManagerGraph {
  const directReports = new Map<UserId, Set<UserId>>();
  for (const [userStr, managerId] of Object.entries(managerOf)) {
    const userId = Number(userStr);
    let reports = directReports.get(managerId);
    if (!reports) {
      reports = new Set<UserId>();
      directReports.set(managerId, reports);
    }
    reports.add(userId);
  }
  return { directReports, areaManagerIds: new Set<UserId>(areaManagers) };
}

/** Sorted array of a Set, so assertions are order-independent. */
function sorted(ids: Iterable<UserId>): UserId[] {
  return [...ids].sort((a, b) => a - b);
}

describe('resolveDownwardHierarchy — transitive downward walk (R19.1)', () => {
  it('includes direct reports and, recursively, their reports', () => {
    // 1 manages 2 and 3; 2 manages 4 and 5; 4 manages 6.
    const graph = graphOf({ 2: 1, 3: 1, 4: 2, 5: 2, 6: 4 });
    assert.deepEqual(sorted(resolveDownwardHierarchy(1, graph)), [
      2, 3, 4, 5, 6,
    ]);
  });

  it('returns an empty set for a person with no reports (a leaf)', () => {
    const graph = graphOf({ 2: 1 });
    assert.deepEqual([...resolveDownwardHierarchy(2, graph)], []);
  });

  it('excludes the root by default and includes it only when opted in', () => {
    const graph = graphOf({ 2: 1, 3: 1 });
    assert.equal(resolveDownwardHierarchy(1, graph).has(1), false);
    assert.deepEqual(
      sorted(resolveDownwardHierarchy(1, graph, { includeRoot: true })),
      [1, 2, 3],
    );
  });

  it('resolves a person mid-chain to only those below them', () => {
    const graph = graphOf({ 2: 1, 4: 2, 5: 2, 6: 4 });
    // From 2's perspective, 1 (their manager) is NOT part of the downward walk.
    assert.deepEqual(sorted(resolveDownwardHierarchy(2, graph)), [4, 5, 6]);
  });
});

describe('resolveDownwardHierarchy — area-manager cutoff (R19.2)', () => {
  it('includes an area-manager report but does NOT descend into their sub-tree', () => {
    // 1 manages 2; 2 (an area manager) manages 3; 3 manages 4.
    // 2 is a genuine report of 1, so it is included, but 2 heads its own
    // hierarchy — so 3 and 4 belong to 2's team, not 1's.
    const graph = graphOf({ 2: 1, 3: 2, 4: 3 }, [2]);
    assert.deepEqual([...resolveDownwardHierarchy(1, graph)], [2]);
  });

  it("still returns an area manager's OWN downward team (root is not its own cutoff)", () => {
    // Asking 2 (an area manager) for their team returns their reports: a
    // boundary only stops traversal when reached AS a report, never for the root.
    const graph = graphOf({ 2: 1, 3: 2, 4: 3 }, [2]);
    assert.deepEqual(sorted(resolveDownwardHierarchy(2, graph)), [3, 4]);
  });

  it('applies the cutoff independently on each branch', () => {
    // 1 manages 2 and 3. 3 is an area manager with reports 5 (excluded).
    // 2 is a normal manager with report 4 (included).
    const graph = graphOf({ 2: 1, 3: 1, 4: 2, 5: 3 }, [3]);
    assert.deepEqual(sorted(resolveDownwardHierarchy(1, graph)), [2, 3, 4]);
  });

  it('cuts off at a deeper area manager only, keeping the reports above it', () => {
    // 1 → 2 → 3(area) → 4. 2 is normal, so it and 3 are included; 3 cuts off 4.
    const graph = graphOf({ 2: 1, 3: 2, 4: 3 }, [3]);
    assert.deepEqual(sorted(resolveDownwardHierarchy(1, graph)), [2, 3]);
  });
});

describe('resolveDownwardHierarchy — cycle termination (R19.4)', () => {
  it('terminates on a self-cycle (a person recorded as their own manager)', () => {
    // 1 manages 1 (self-loop) and also manages 2. Must not loop forever.
    const graph = graphOf({ 1: 1, 2: 1 });
    const result = resolveDownwardHierarchy(1, graph);
    // The self-edge does not add the root to its own downward hierarchy.
    assert.deepEqual([...result], [2]);
  });

  it('terminates on a two-node cycle (a → b → a)', () => {
    // 1 manages 2; 2 manages 1 (points back at the root). Must terminate.
    const graph = graphOf({ 2: 1, 1: 2 });
    assert.deepEqual([...resolveDownwardHierarchy(1, graph)], [2]);
  });

  it('terminates on a longer multi-node cycle (a → b → c → a)', () => {
    // 1 → 2 → 3 → 1. Everyone but the root appears exactly once; no infinite loop.
    const graph = graphOf({ 2: 1, 3: 2, 1: 3 });
    assert.deepEqual(sorted(resolveDownwardHierarchy(1, graph)), [2, 3]);
  });

  it('terminates on a cycle NOT involving the root, with reports off the cycle', () => {
    // 1 → 2; 2 → 3; 3 → {2, 4} — a 2↔3 cycle below the root, plus 4 hanging off
    // it. Built explicitly (a plain edge map cannot express two managers for 2).
    const cyclic: ManagerGraph = {
      directReports: new Map<UserId, Set<UserId>>([
        [1, new Set([2])],
        [2, new Set([3])],
        [3, new Set([2, 4])],
      ]),
      areaManagerIds: new Set<UserId>(),
    };
    assert.deepEqual(sorted(resolveDownwardHierarchy(1, cyclic)), [2, 3, 4]);
  });

  it('expands each person at most once even in a diamond (shared sub-report)', () => {
    // 1 → {2, 3}, both 2 and 3 → 4, 4 → 5 (diamond). 4 is reached via two paths
    // but expanded once; 5 still appears. Built explicitly (an edge map cannot
    // give 4 two managers).
    const diamond: ManagerGraph = {
      directReports: new Map<UserId, Set<UserId>>([
        [1, new Set([2, 3])],
        [2, new Set([4])],
        [3, new Set([4])],
        [4, new Set([5])],
      ]),
      areaManagerIds: new Set<UserId>(),
    };
    assert.deepEqual(sorted(resolveDownwardHierarchy(1, diamond)), [2, 3, 4, 5]);
  });

  it('does not mutate the injected graph', () => {
    const graph = graphOf({ 2: 1, 3: 2 });
    const before = graph.directReports.get(1)?.size;
    resolveDownwardHierarchy(1, graph);
    assert.equal(graph.directReports.get(1)?.size, before);
    assert.equal(graph.areaManagerIds.size, 0);
  });
});
