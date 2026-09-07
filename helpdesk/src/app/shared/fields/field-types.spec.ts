import { FormControl } from '@angular/forms';
import {
  fieldValidator,
  isBoolean,
  isDataType,
  isEmpty,
  isNumeric,
  isValidDate,
  isValidDateTime,
  isValidEmail,
  isValidTime,
  resolveOptions,
  validateFieldValue,
  type FieldDefinition,
} from './field-types';

/** Build a minimal field definition for a data type. */
function field(over: Partial<FieldDefinition> & Pick<FieldDefinition, 'dataType'>): FieldDefinition {
  return {
    id: 'f1',
    label: 'Field',
    isMandatory: false,
    ...over,
  };
}

describe('isDataType', () => {
  it('accepts each of the nine data types (R3.1)', () => {
    for (const t of [
      'TEXT',
      'EMAIL',
      'DATE',
      'NUMERIC',
      'DATETIME',
      'TIME',
      'BOOLEAN',
      'DROPDOWN',
      'REGEXP',
    ]) {
      expect(isDataType(t)).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(isDataType('PHONE')).toBe(false);
    expect(isDataType(null)).toBe(false);
    expect(isDataType(7)).toBe(false);
  });
});

describe('isEmpty (R3.6)', () => {
  it('treats null/undefined/blank strings as empty', () => {
    expect(isEmpty(null)).toBe(true);
    expect(isEmpty(undefined)).toBe(true);
    expect(isEmpty('')).toBe(true);
    expect(isEmpty('   ')).toBe(true);
  });

  it('treats false and 0 as NOT empty', () => {
    expect(isEmpty(false)).toBe(false);
    expect(isEmpty(0)).toBe(false);
    expect(isEmpty('x')).toBe(false);
  });
});

describe('type checkers mirror the backend rules (R3)', () => {
  it('validates email (R3.2)', () => {
    expect(isValidEmail('a@b.com')).toBe(true);
    expect(isValidEmail('first.last@sub.example.co')).toBe(true);
    expect(isValidEmail('nope')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a b@c.com')).toBe(false);
  });

  it('validates numeric, excluding hex/binary/Infinity (R3.3)', () => {
    expect(isNumeric('42')).toBe(true);
    expect(isNumeric('-3.14')).toBe(true);
    expect(isNumeric('1e3')).toBe(true);
    expect(isNumeric(7)).toBe(true);
    expect(isNumeric('0x10')).toBe(false);
    expect(isNumeric('Infinity')).toBe(false);
    expect(isNumeric('12abc')).toBe(false);
    expect(isNumeric('')).toBe(false);
  });

  it('validates ISO date and rejects impossible calendar dates', () => {
    expect(isValidDate('2026-02-05')).toBe(true);
    expect(isValidDate('2023-02-30')).toBe(false);
    expect(isValidDate('05/02/2026')).toBe(false);
  });

  it('validates date-time requiring a time component', () => {
    expect(isValidDateTime('2026-02-05T14:30')).toBe(true);
    expect(isValidDateTime('2026-02-05T14:30:00Z')).toBe(true);
    expect(isValidDateTime('2026-02-05')).toBe(false);
  });

  it('validates 24-hour time', () => {
    expect(isValidTime('14:30')).toBe(true);
    expect(isValidTime('23:59:59')).toBe(true);
    expect(isValidTime('24:00')).toBe(false);
    expect(isValidTime('9:5')).toBe(false);
  });

  it('validates boolean including string forms', () => {
    expect(isBoolean(true)).toBe(true);
    expect(isBoolean('false')).toBe(true);
    expect(isBoolean('TRUE')).toBe(true);
    expect(isBoolean('yes')).toBe(false);
  });
});

describe('resolveOptions (R3.5)', () => {
  it('returns the field options or an empty list', () => {
    expect(resolveOptions(field({ dataType: 'DROPDOWN', options: ['A', 'B'] }))).toEqual(['A', 'B']);
    expect(resolveOptions(field({ dataType: 'DROPDOWN' }))).toEqual([]);
  });
});

describe('validateFieldValue (R3, R3.6)', () => {
  it('rejects an empty mandatory field with MANDATORY_FIELD and the server wording', () => {
    const result = validateFieldValue(field({ dataType: 'TEXT', isMandatory: true, label: 'Title' }), '');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('MANDATORY_FIELD');
      expect(result.message).toBe('Title is required');
    }
  });

  it('accepts an empty optional field (nothing to type-check)', () => {
    expect(validateFieldValue(field({ dataType: 'EMAIL' }), '').valid).toBe(true);
  });

  it('rejects a bad email with VALIDATION_FAILED and the server wording (R3.2)', () => {
    const result = validateFieldValue(field({ dataType: 'EMAIL', label: 'Email' }), 'nope');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('VALIDATION_FAILED');
      expect(result.message).toBe('Email must be a valid email address');
    }
  });

  it('rejects a value outside the dropdown options (R3.5)', () => {
    const f = field({ dataType: 'DROPDOWN', options: ['A', 'B'] });
    expect(validateFieldValue(f, 'A').valid).toBe(true);
    expect(validateFieldValue(f, 'C').valid).toBe(false);
  });

  it('rejects a value that does not match a regexp pattern (R3.4)', () => {
    const f = field({ dataType: 'REGEXP', regexpPattern: '^[A-Z]{3}$' });
    expect(validateFieldValue(f, 'ABC').valid).toBe(true);
    expect(validateFieldValue(f, 'abc').valid).toBe(false);
  });

  it('rejects a regexp field with no pattern defined', () => {
    const f = field({ dataType: 'REGEXP' });
    expect(validateFieldValue(f, 'ABC').valid).toBe(false);
  });

  it('accepts valid values across every type', () => {
    expect(validateFieldValue(field({ dataType: 'TEXT' }), 'hello').valid).toBe(true);
    expect(validateFieldValue(field({ dataType: 'NUMERIC' }), '42').valid).toBe(true);
    expect(validateFieldValue(field({ dataType: 'DATE' }), '2026-02-05').valid).toBe(true);
    expect(validateFieldValue(field({ dataType: 'DATETIME' }), '2026-02-05T14:30').valid).toBe(true);
    expect(validateFieldValue(field({ dataType: 'TIME' }), '14:30').valid).toBe(true);
    expect(validateFieldValue(field({ dataType: 'BOOLEAN' }), true).valid).toBe(true);
  });
});

describe('fieldValidator', () => {
  it('returns null for a valid control value', () => {
    const validator = fieldValidator(field({ dataType: 'NUMERIC' }));
    expect(validator(new FormControl('42'))).toBeNull();
  });

  it('returns { fieldError: { code, message } } for an invalid value', () => {
    const validator = fieldValidator(field({ dataType: 'EMAIL', label: 'Email', isMandatory: true }));
    const errors = validator(new FormControl(''));
    expect(errors).not.toBeNull();
    expect(errors?.['fieldError']).toEqual({
      code: 'MANDATORY_FIELD',
      message: 'Email is required',
    });
  });
});
