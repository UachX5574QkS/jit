import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../middleware/errors.js';
import {
  DATA_TYPES,
  type DataType,
  type FieldDefinition,
  isDataType,
  isEmpty,
  isValidEmail,
  isNumeric,
  isValidDate,
  isValidDateTime,
  isValidTime,
  isBoolean,
  resolveOptions,
  validateField,
  assertField,
  validateFields,
  assertFields,
} from './validation.js';

/**
 * DB-free unit tests for server-side field validation (R3), matching the
 * node:test + node:assert/strict, pure-module style of the other cross-cutting
 * modules. They cover EVERY data type (R3.1) — with emphasis on email (R3.2),
 * numeric (R3.3) and regexp (R3.4) — the dropdown option/override resolution
 * (R3.5), the date/date-time/time/boolean formats, and mandatory-empty handling
 * (R3.6), plus the guard variants and the collect-all-failures form.
 */

/** Build a field definition with sane defaults for a data type. */
function field(
  dataType: DataType,
  extra: Partial<FieldDefinition> = {},
): FieldDefinition {
  return { dataType, isMandatory: false, ...extra };
}

describe('isDataType (R3.1)', () => {
  it('accepts every one of the nine known data types', () => {
    for (const t of DATA_TYPES) {
      assert.equal(isDataType(t), true, t);
    }
  });

  it('rejects unknown strings and non-strings', () => {
    assert.equal(isDataType('STRING'), false);
    assert.equal(isDataType('text'), false); // case-sensitive
    assert.equal(isDataType(''), false);
    assert.equal(isDataType(null), false);
    assert.equal(isDataType(undefined), false);
    assert.equal(isDataType(1), false);
  });
});

describe('isEmpty (R3.6)', () => {
  it('treats null, undefined, and blank/whitespace strings as empty', () => {
    assert.equal(isEmpty(null), true);
    assert.equal(isEmpty(undefined), true);
    assert.equal(isEmpty(''), true);
    assert.equal(isEmpty('   '), true);
    assert.equal(isEmpty('\t\n'), true);
  });

  it('treats non-blank strings, numbers, and booleans as non-empty', () => {
    assert.equal(isEmpty('x'), false);
    assert.equal(isEmpty(' x '), false);
    assert.equal(isEmpty(0), false);
    assert.equal(isEmpty(false), false);
  });
});

describe('mandatory-empty handling (R3.6)', () => {
  it('rejects an empty value on a mandatory field of any type with MANDATORY_FIELD', () => {
    for (const t of DATA_TYPES) {
      const result = validateField(field(t, { isMandatory: true }), '');
      assert.equal(result.valid, false, t);
      if (!result.valid) {
        assert.equal(result.code, 'MANDATORY_FIELD', t);
      }
    }
  });

  it('rejects null and whitespace-only on a mandatory field', () => {
    const f = field('TEXT', { isMandatory: true });
    for (const empty of [null, undefined, '', '   ']) {
      const result = validateField(f, empty);
      assert.equal(result.valid, false);
      if (!result.valid) {
        assert.equal(result.code, 'MANDATORY_FIELD');
      }
    }
  });

  it('accepts an empty value on an OPTIONAL field and skips the type check', () => {
    // An optional email left blank must NOT fail the email format check.
    assert.equal(validateField(field('EMAIL'), '').valid, true);
    assert.equal(validateField(field('NUMERIC'), null).valid, true);
    assert.equal(validateField(field('DATE'), '   ').valid, true);
  });

  it('includes the field name in the required message when provided', () => {
    const result = validateField(
      field('TEXT', { isMandatory: true, name: 'Summary' }),
      '',
    );
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.match(result.message, /Summary/);
      assert.match(result.message, /required/);
    }
  });
});

describe('TEXT (R3.1)', () => {
  it('accepts any non-empty text', () => {
    assert.equal(validateField(field('TEXT'), 'hello').valid, true);
    assert.equal(validateField(field('TEXT'), '123 !@#').valid, true);
  });
});

describe('EMAIL (R3.2)', () => {
  const valid = [
    'user@example.com',
    'first.last@example.co.uk',
    'a+tag@sub.domain.org',
    'name_123@host.io',
  ];
  const invalid = [
    'plainaddress',
    '@no-local.com',
    'no-at-sign.com',
    'user@',
    'user@nodot',
    'user@domain.c', // TLD too short
    'has space@example.com',
    'user@@example.com',
    'user@exam ple.com',
  ];

  for (const v of valid) {
    it(`accepts ${v}`, () => {
      assert.equal(isValidEmail(v), true);
      assert.equal(validateField(field('EMAIL'), v).valid, true);
    });
  }

  for (const v of invalid) {
    it(`rejects ${JSON.stringify(v)}`, () => {
      assert.equal(isValidEmail(v), false);
      const result = validateField(field('EMAIL'), v);
      assert.equal(result.valid, false);
      if (!result.valid) {
        assert.equal(result.code, 'VALIDATION_FAILED');
      }
    });
  }

  it('trims surrounding whitespace before validating', () => {
    assert.equal(isValidEmail('  user@example.com  '), true);
  });
});

describe('NUMERIC (R3.3)', () => {
  const valid: unknown[] = ['0', '42', '-3', '3.14', '  10  ', '1e3', 100, -0.5];
  const invalid: unknown[] = ['abc', '12abc', '1,000', '', '   ', 'NaN', 'Infinity', '0x10'];

  for (const v of valid) {
    it(`accepts ${JSON.stringify(v)}`, () => {
      assert.equal(isNumeric(v), true);
      assert.equal(validateField(field('NUMERIC'), v).valid, true);
    });
  }

  for (const v of invalid) {
    it(`rejects ${JSON.stringify(v)}`, () => {
      assert.equal(isNumeric(v), false);
    });
  }

  it('rejects non-numeric input on a numeric field with VALIDATION_FAILED', () => {
    const result = validateField(field('NUMERIC'), 'not-a-number');
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.code, 'VALIDATION_FAILED');
      assert.match(result.message, /numeric/);
    }
  });
});

describe('REGEXP (R3.4)', () => {
  it('accepts values matching the field pattern', () => {
    const f = field('REGEXP', { regexpPattern: '^[A-Z]{3}-\\d{4}$' });
    assert.equal(validateField(f, 'ABC-1234').valid, true);
  });

  it('rejects values not matching the field pattern', () => {
    const f = field('REGEXP', { regexpPattern: '^[A-Z]{3}-\\d{4}$' });
    const result = validateField(f, 'abc-1234');
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.code, 'VALIDATION_FAILED');
    }
  });

  it('validates a different pattern (digits only)', () => {
    const f = field('REGEXP', { regexpPattern: '^\\d+$' });
    assert.equal(validateField(f, '007').valid, true);
    assert.equal(validateField(f, '00a').valid, false);
  });

  it('throws VALIDATION_FAILED when the field has no pattern defined', () => {
    const f = field('REGEXP', { regexpPattern: null });
    assert.throws(
      () => validateField(f, 'anything'),
      (err: unknown) =>
        err instanceof ApiError && err.code === 'VALIDATION_FAILED',
    );
  });

  it('throws VALIDATION_FAILED when the pattern is not a valid regex', () => {
    const f = field('REGEXP', { regexpPattern: '([unclosed' });
    assert.throws(
      () => validateField(f, 'x'),
      (err: unknown) =>
        err instanceof ApiError && err.code === 'VALIDATION_FAILED',
    );
  });
});

describe('DROPDOWN (R3.5)', () => {
  it('accepts a value in the data point default list', () => {
    const f = field('DROPDOWN', { defaultOptions: ['Low', 'Medium', 'High'] });
    assert.equal(validateField(f, 'Medium').valid, true);
  });

  it('rejects a value not in the option list', () => {
    const f = field('DROPDOWN', { defaultOptions: ['Low', 'Medium', 'High'] });
    const result = validateField(f, 'Urgent');
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.code, 'VALIDATION_FAILED');
    }
  });

  it('uses the task-level override list when present (R3.5)', () => {
    const f = field('DROPDOWN', {
      defaultOptions: ['Low', 'Medium', 'High'],
      optionsOverride: ['P1', 'P2'],
    });
    assert.equal(validateField(f, 'P1').valid, true);
    // A default-list value is no longer valid once overridden.
    assert.equal(validateField(f, 'Medium').valid, false);
  });

  it('resolveOptions prefers the override, falls back to defaults, else []', () => {
    assert.deepEqual(
      resolveOptions(field('DROPDOWN', { optionsOverride: ['a'], defaultOptions: ['b'] })),
      ['a'],
    );
    assert.deepEqual(
      resolveOptions(field('DROPDOWN', { defaultOptions: ['b'] })),
      ['b'],
    );
    assert.deepEqual(resolveOptions(field('DROPDOWN')), []);
  });

  it('treats an empty override array as the (empty) option list, not a fallback', () => {
    const f = field('DROPDOWN', {
      optionsOverride: [],
      defaultOptions: ['x'],
    });
    // Override is present (non-null) but empty → nothing is a valid option.
    assert.equal(validateField(f, 'x').valid, false);
  });
});

describe('DATE (R3.1)', () => {
  it('accepts a well-formed calendar date', () => {
    assert.equal(isValidDate('2024-02-29'), true); // leap year
    assert.equal(validateField(field('DATE'), '2023-11-15').valid, true);
  });

  it('rejects malformed or impossible dates', () => {
    assert.equal(isValidDate('2023-13-01'), false); // month 13
    assert.equal(isValidDate('2023-02-30'), false); // no Feb 30
    assert.equal(isValidDate('2023-2-1'), false); // not zero-padded
    assert.equal(isValidDate('15/11/2023'), false); // wrong format
    assert.equal(isValidDate('not-a-date'), false);
  });
});

describe('DATETIME (R3.1)', () => {
  it('accepts an ISO-8601 date+time', () => {
    assert.equal(isValidDateTime('2023-11-15T09:30:00Z'), true);
    assert.equal(isValidDateTime('2023-11-15T09:30'), true);
    assert.equal(
      validateField(field('DATETIME'), '2023-11-15T09:30:00.000Z').valid,
      true,
    );
  });

  it('rejects a bare date or malformed value', () => {
    assert.equal(isValidDateTime('2023-11-15'), false); // no time part
    assert.equal(isValidDateTime('2023-11-15T99:99'), false);
    assert.equal(isValidDateTime('nonsense'), false);
  });
});

describe('TIME (R3.1)', () => {
  it('accepts HH:MM and HH:MM:SS in 24-hour form', () => {
    assert.equal(isValidTime('00:00'), true);
    assert.equal(isValidTime('23:59'), true);
    assert.equal(isValidTime('09:30:15'), true);
    assert.equal(validateField(field('TIME'), '14:05').valid, true);
  });

  it('rejects out-of-range or malformed times', () => {
    assert.equal(isValidTime('24:00'), false);
    assert.equal(isValidTime('12:60'), false);
    assert.equal(isValidTime('9:30'), false); // not zero-padded
    assert.equal(isValidTime('noon'), false);
  });
});

describe('BOOLEAN (R3.1)', () => {
  it('accepts booleans and the strings true/false', () => {
    assert.equal(isBoolean(true), true);
    assert.equal(isBoolean(false), true);
    assert.equal(isBoolean('true'), true);
    assert.equal(isBoolean('False'), true); // case-insensitive
    assert.equal(validateField(field('BOOLEAN'), 'true').valid, true);
  });

  it('rejects non-boolean values', () => {
    assert.equal(isBoolean('yes'), false);
    assert.equal(isBoolean('1'), false);
    assert.equal(isBoolean(1), false);
    const result = validateField(field('BOOLEAN'), 'maybe');
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.code, 'VALIDATION_FAILED');
    }
  });
});

describe('assertField (guard variant, R3)', () => {
  it('returns normally for a valid value', () => {
    assert.doesNotThrow(() => assertField(field('EMAIL'), 'a@b.com'));
  });

  it('throws ApiError 409 MANDATORY_FIELD for an empty mandatory field (R3.6)', () => {
    try {
      assertField(field('TEXT', { isMandatory: true, name: 'Title' }), '');
      assert.fail('expected assertField to throw');
    } catch (err) {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 409);
      assert.equal(err.code, 'MANDATORY_FIELD');
      assert.deepEqual(err.details, { name: 'Title', dataType: 'TEXT' });
    }
  });

  it('throws ApiError 400 VALIDATION_FAILED for a type mismatch', () => {
    try {
      assertField(field('NUMERIC', { name: 'Count' }), 'abc');
      assert.fail('expected assertField to throw');
    } catch (err) {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 400);
      assert.equal(err.code, 'VALIDATION_FAILED');
      assert.deepEqual(err.details, { name: 'Count', dataType: 'NUMERIC' });
    }
  });
});

describe('validateFields / assertFields (collect all, R2.10)', () => {
  it('returns an empty array when every field passes', () => {
    const errors = validateFields([
      { field: field('EMAIL'), value: 'a@b.com' },
      { field: field('NUMERIC'), value: '5' },
    ]);
    assert.deepEqual(errors, []);
  });

  it('collects EVERY failure rather than stopping at the first', () => {
    const errors = validateFields([
      { field: field('TEXT', { isMandatory: true, name: 'Title' }), value: '' },
      { field: field('EMAIL', { name: 'Contact' }), value: 'bad' },
      { field: field('NUMERIC', { name: 'Qty' }), value: 'x' },
      { field: field('TEXT', { name: 'Notes' }), value: 'fine' },
    ]);
    assert.equal(errors.length, 3);
    assert.deepEqual(
      errors.map((e) => e.field),
      ['Title', 'Contact', 'Qty'],
    );
    assert.equal(errors[0].code, 'MANDATORY_FIELD');
    assert.equal(errors[1].code, 'VALIDATION_FAILED');
  });

  it('assertFields throws MANDATORY_FIELD (409) when any failure is a required-empty one', () => {
    try {
      assertFields([
        { field: field('TEXT', { isMandatory: true, name: 'Title' }), value: '' },
        { field: field('EMAIL', { name: 'Contact' }), value: 'bad' },
      ]);
      assert.fail('expected assertFields to throw');
    } catch (err) {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 409);
      assert.equal(err.code, 'MANDATORY_FIELD');
      const details = err.details as { errors: unknown[] };
      assert.equal(details.errors.length, 2);
    }
  });

  it('assertFields throws VALIDATION_FAILED (400) when only type failures exist', () => {
    try {
      assertFields([{ field: field('NUMERIC', { name: 'Qty' }), value: 'x' }]);
      assert.fail('expected assertFields to throw');
    } catch (err) {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 400);
      assert.equal(err.code, 'VALIDATION_FAILED');
    }
  });

  it('assertFields returns normally when all pass', () => {
    assert.doesNotThrow(() =>
      assertFields([{ field: field('BOOLEAN'), value: true }]),
    );
  });
});
