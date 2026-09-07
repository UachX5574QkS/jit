/**
 * The column-level audit writer (design: "Audit", R17.1, R17.2).
 *
 * Feature code that mutates an audited entity imports {@link AuditWriter} (and,
 * when convenient, the pure {@link diffFields}) from here and records the
 * changed columns through the SAME transaction client as the mutation, so the
 * audit trail and the change it describes commit or roll back together.
 */
export type {
  AuditContext,
  AuditableValue,
  FieldChange,
  FieldSnapshot,
} from './audit-writer.js';
export { AuditWriter, diffFields, normaliseValue } from './audit-writer.js';
