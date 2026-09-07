import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../middleware/errors.js';
import {
  STATUSES,
  STOP_STATES,
  type Status,
  isStatus,
  isStopState,
  canTransition,
  assertTransition,
  canReopen,
  assertReopen,
  allowedTargets,
} from './status.js';

/**
 * DB-free unit tests for the central status state machine (R9), matching the
 * node:test + node:assert/strict, injectable/pure style of the other
 * cross-cutting modules. They assert EVERY allowed general-machine transition,
 * representative blocked transitions, COMPLETE-only-from-ACTIVE (R9.5),
 * cancel-from-any-non-stop (R9.6), and the constrained raiser Reopen edge
 * (R5.6) — which is deliberately outside the general machine.
 */

/** The general-machine allowed edges from the design (R9.4), excluding the
 * implicit "→ CANCELLED from any non-stop" edge (asserted separately). */
const ALLOWED: ReadonlyArray<readonly [Status, Status]> = [
  ['NEW', 'TRIAGE'],
  ['TRIAGE', 'ACCEPTED'],
  ['TRIAGE', 'REJECTED'],
  ['ACCEPTED', 'ASSIGNED'],
  ['ASSIGNED', 'ACTIVE'],
  ['ASSIGNED', 'PAUSED'],
  ['ASSIGNED', 'BLOCKED'],
  ['PAUSED', 'ACTIVE'],
  ['BLOCKED', 'ACTIVE'],
  ['ACTIVE', 'COMPLETE'],
  ['ACTIVE', 'PAUSED'],
  ['ACTIVE', 'BLOCKED'],
];

/** Representative transitions that must be rejected (R9.7). */
const BLOCKED: ReadonlyArray<readonly [Status, Status]> = [
  ['NEW', 'ACCEPTED'], // skips TRIAGE
  ['NEW', 'ACTIVE'], // skips the middle of the lifecycle
  ['NEW', 'COMPLETE'], // COMPLETE only from ACTIVE (R9.5)
  ['TRIAGE', 'ASSIGNED'], // skips ACCEPTED
  ['ACCEPTED', 'ACTIVE'], // skips ASSIGNED
  ['ASSIGNED', 'COMPLETE'], // COMPLETE only from ACTIVE (R9.5)
  ['PAUSED', 'COMPLETE'], // must return to ACTIVE first
  ['BLOCKED', 'COMPLETE'], // must return to ACTIVE first
  ['PAUSED', 'BLOCKED'], // holds do not chain directly
  ['ACTIVE', 'ASSIGNED'], // no going back to ASSIGNED
  ['TRIAGE', 'NEW'], // no general path back to NEW
  ['ACTIVE', 'REJECTED'], // reject only from TRIAGE
];

describe('isStatus', () => {
  it('accepts every one of the ten known statuses', () => {
    for (const s of STATUSES) {
      assert.equal(isStatus(s), true, s);
    }
  });

  it('rejects unknown strings and non-strings', () => {
    assert.equal(isStatus('OPEN'), false);
    assert.equal(isStatus('new'), false); // case-sensitive
    assert.equal(isStatus(''), false);
    assert.equal(isStatus(null), false);
    assert.equal(isStatus(undefined), false);
    assert.equal(isStatus(1), false);
  });
});

describe('isStopState (R9.3)', () => {
  it('treats exactly REJECTED, CANCELLED, COMPLETE as stop states', () => {
    assert.deepEqual([...STOP_STATES].sort(), [
      'CANCELLED',
      'COMPLETE',
      'REJECTED',
    ]);
    for (const s of STATUSES) {
      const expected = s === 'REJECTED' || s === 'CANCELLED' || s === 'COMPLETE';
      assert.equal(isStopState(s), expected, s);
    }
  });
});

describe('canTransition — allowed transitions (R9.4)', () => {
  for (const [from, to] of ALLOWED) {
    it(`permits ${from} → ${to}`, () => {
      assert.equal(canTransition(from, to), true);
    });
  }
});

describe('canTransition — blocked transitions (R9.7)', () => {
  for (const [from, to] of BLOCKED) {
    it(`rejects ${from} → ${to}`, () => {
      assert.equal(canTransition(from, to), false);
    });
  }

  it('rejects a no-op (same status is not a transition)', () => {
    for (const s of STATUSES) {
      assert.equal(canTransition(s, s), false, s);
    }
  });

  it('rejects all outbound transitions from every stop state (terminal)', () => {
    for (const from of STOP_STATES) {
      for (const to of STATUSES) {
        // CANCELLED → NEW is only reachable via the constrained reopen path,
        // never the general machine (asserted below).
        assert.equal(canTransition(from, to), false, `${from} → ${to}`);
      }
    }
  });
});

describe('COMPLETE is reachable only from ACTIVE (R9.5)', () => {
  it('permits ACTIVE → COMPLETE and rejects COMPLETE from anywhere else', () => {
    for (const from of STATUSES) {
      const expected = from === 'ACTIVE';
      assert.equal(canTransition(from, 'COMPLETE'), expected, from);
    }
  });
});

describe('CANCELLED is reachable from any non-stop state (R9.6)', () => {
  it('permits → CANCELLED from every non-stop state and rejects it from stop states', () => {
    for (const from of STATUSES) {
      const expected = !isStopState(from);
      assert.equal(canTransition(from, 'CANCELLED'), expected, from);
    }
  });
});

describe('constrained raiser Reopen path CANCELLED → NEW (R5.6)', () => {
  it('the general machine does NOT permit CANCELLED → NEW by default', () => {
    assert.equal(canTransition('CANCELLED', 'NEW'), false);
  });

  it('is permitted only when the allowReopen flag is opted into', () => {
    assert.equal(canTransition('CANCELLED', 'NEW', { allowReopen: true }), true);
  });

  it('canReopen recognises exactly CANCELLED → NEW and nothing else', () => {
    assert.equal(canReopen('CANCELLED', 'NEW'), true);
    assert.equal(canReopen('COMPLETE', 'NEW'), false);
    assert.equal(canReopen('REJECTED', 'NEW'), false);
    assert.equal(canReopen('CANCELLED', 'TRIAGE'), false);
    assert.equal(canReopen('ACTIVE', 'NEW'), false);
  });

  it('allowReopen does not open any other edge out of a stop state', () => {
    assert.equal(
      canTransition('CANCELLED', 'ACTIVE', { allowReopen: true }),
      false,
    );
    assert.equal(
      canTransition('COMPLETE', 'NEW', { allowReopen: true }),
      false,
    );
  });
});

describe('assertTransition (guard variant, R9.7)', () => {
  it('returns normally for an allowed transition', () => {
    assert.doesNotThrow(() => assertTransition('NEW', 'TRIAGE'));
  });

  it('throws ApiError 409 INVALID_TRANSITION with from/to details on a blocked one', () => {
    try {
      assertTransition('NEW', 'COMPLETE');
      assert.fail('expected assertTransition to throw');
    } catch (err) {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 409);
      assert.equal(err.code, 'INVALID_TRANSITION');
      assert.deepEqual(err.details, { from: 'NEW', to: 'COMPLETE' });
    }
  });

  it('honours allowReopen for the reopen edge', () => {
    assert.doesNotThrow(() =>
      assertTransition('CANCELLED', 'NEW', { allowReopen: true }),
    );
    assert.throws(() => assertTransition('CANCELLED', 'NEW'), ApiError);
  });
});

describe('assertReopen (guard variant, R5.6)', () => {
  it('returns normally for CANCELLED → NEW', () => {
    assert.doesNotThrow(() => assertReopen('CANCELLED', 'NEW'));
  });

  it('throws INVALID_TRANSITION for any other pair', () => {
    try {
      assertReopen('COMPLETE', 'NEW');
      assert.fail('expected assertReopen to throw');
    } catch (err) {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, 'INVALID_TRANSITION');
      assert.deepEqual(err.details, { from: 'COMPLETE', to: 'NEW' });
    }
  });
});

describe('allowedTargets', () => {
  it('lists the general-machine targets (incl. CANCELLED) in STATUSES order', () => {
    assert.deepEqual(allowedTargets('ASSIGNED'), [
      'ACTIVE',
      'PAUSED',
      'BLOCKED',
      'CANCELLED',
    ]);
    assert.deepEqual(allowedTargets('ACTIVE'), [
      'PAUSED',
      'BLOCKED',
      'CANCELLED',
      'COMPLETE',
    ]);
  });

  it('returns an empty list for every stop state', () => {
    for (const from of STOP_STATES) {
      assert.deepEqual(allowedTargets(from), []);
    }
  });

  it('never includes the source status itself (no self-loop)', () => {
    for (const from of STATUSES) {
      assert.equal(allowedTargets(from).includes(from), false, from);
    }
  });
});
