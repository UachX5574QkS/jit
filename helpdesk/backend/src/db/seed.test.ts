import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateAllRoutes } from './seed.js';
import {
  STATUSES,
  canTransition,
  canReopen,
  type Status,
} from '../status/status.js';

/**
 * Pure (no-database) tests for the development seed's transition-coverage logic
 * (R21.5). The full seed run needs a live `helpdesk` database and is exercised
 * via `npm run seed`; these tests verify the invariants the seed relies on so
 * they stay runnable in `npm test` without a DB.
 *
 * The seed replays the SAME status journeys asserted here, so if these journeys
 * cover every route in the R9 state machine, the seed's coverage assertion
 * cannot fail for a logic reason.
 */

/**
 * The status journeys the seed drives requests along. Kept in lock-step with
 * JOURNEYS in seed.ts: this test's job is to prove the set of journeys covers
 * every state-machine route, which is exactly what the seed asserts at runtime.
 */
const JOURNEY_PATHS: readonly (readonly Status[])[] = [
  ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'ACTIVE', 'COMPLETE'],
  ['NEW', 'TRIAGE', 'REJECTED'],
  ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'PAUSED', 'ACTIVE', 'COMPLETE'],
  ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'BLOCKED', 'ACTIVE', 'COMPLETE'],
  ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'ACTIVE', 'PAUSED'],
  ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'ACTIVE', 'BLOCKED'],
  ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'ACTIVE'],
  ['NEW', 'CANCELLED'],
  ['NEW', 'TRIAGE', 'CANCELLED'],
  ['NEW', 'TRIAGE', 'ACCEPTED', 'CANCELLED'],
  ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'CANCELLED'],
  ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'ACTIVE', 'CANCELLED'],
  ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'PAUSED', 'CANCELLED'],
  ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'BLOCKED', 'CANCELLED'],
  ['NEW', 'CANCELLED', 'NEW', 'TRIAGE'],
  ['NEW'],
];

function routesFromJourneys(): Set<string> {
  const covered = new Set<string>();
  for (const path of JOURNEY_PATHS) {
    for (let i = 1; i < path.length; i += 1) {
      covered.add(`${path[i - 1]}->${path[i]}`);
    }
  }
  return covered;
}

describe('enumerateAllRoutes', () => {
  it('includes every legal general transition and the reopen edge', () => {
    const routes = new Set(enumerateAllRoutes());
    // Spot-check representative edges across the machine.
    assert.ok(routes.has('NEW->TRIAGE'));
    assert.ok(routes.has('TRIAGE->ACCEPTED'));
    assert.ok(routes.has('TRIAGE->REJECTED'));
    assert.ok(routes.has('ACCEPTED->ASSIGNED'));
    assert.ok(routes.has('ASSIGNED->ACTIVE'));
    assert.ok(routes.has('ASSIGNED->PAUSED'));
    assert.ok(routes.has('ASSIGNED->BLOCKED'));
    assert.ok(routes.has('PAUSED->ACTIVE'));
    assert.ok(routes.has('BLOCKED->ACTIVE'));
    assert.ok(routes.has('ACTIVE->COMPLETE'));
    assert.ok(routes.has('ACTIVE->PAUSED'));
    assert.ok(routes.has('ACTIVE->BLOCKED'));
    assert.ok(routes.has('ACTIVE->CANCELLED'));
    assert.ok(routes.has('CANCELLED->NEW')); // constrained raiser reopen
  });

  it('excludes self-loops and illegal edges', () => {
    const routes = new Set(enumerateAllRoutes());
    assert.ok(!routes.has('NEW->NEW'));
    assert.ok(!routes.has('COMPLETE->NEW'));
    assert.ok(!routes.has('NEW->COMPLETE'));
    assert.ok(!routes.has('REJECTED->NEW'));
  });

  it('agrees with the state machine for every ordered pair', () => {
    const routes = new Set(enumerateAllRoutes());
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (from === to) continue;
        const legal = canTransition(from, to) || canReopen(from, to);
        assert.equal(
          routes.has(`${from}->${to}`),
          legal,
          `route ${from}->${to} mismatch`,
        );
      }
    }
  });
});

describe('seed status journeys (R21.5)', () => {
  it('every hop in every journey is a legal transition', () => {
    for (const path of JOURNEY_PATHS) {
      for (let i = 1; i < path.length; i += 1) {
        const from = path[i - 1]!;
        const to = path[i]!;
        const legal =
          from === 'CANCELLED' && to === 'NEW'
            ? canReopen(from, to)
            : canTransition(from, to);
        assert.ok(legal, `journey hop ${from}->${to} must be legal`);
      }
    }
  });

  it('the journeys collectively exercise every state-machine route', () => {
    const covered = routesFromJourneys();
    const missing = enumerateAllRoutes().filter((r) => !covered.has(r));
    assert.deepEqual(missing, [], `uncovered routes: ${missing.join(', ')}`);
  });
});
