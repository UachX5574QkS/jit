import { describe, it, expect } from 'vitest';
import { auditFieldLabel } from './audit-labels';

describe('auditFieldLabel', () => {
  it('maps known request/note columns to friendly titles', () => {
    expect(auditFieldLabel('status')).toBe('Status');
    expect(auditFieldLabel('assigned_member_id')).toBe('Assigned To');
    expect(auditFieldLabel('jira_number')).toBe('Jira');
    expect(auditFieldLabel('estimated_start_date')).toBe('Estimated Start');
    expect(auditFieldLabel('actual_start_date')).toBe('Actual Start');
    expect(auditFieldLabel('body')).toBe('Note');
    expect(auditFieldLabel('is_internal')).toBe('Internal Note');
    expect(auditFieldLabel('title')).toBe('Title');
    expect(auditFieldLabel('raised_by_id')).toBe('Raised By');
    expect(auditFieldLabel('team_id')).toBe('Team');
    expect(auditFieldLabel('task_version_id')).toBe('Task');
    expect(auditFieldLabel('task_reference')).toBe('Reference');
  });

  it('title-cases any unmapped snake_case name so no internal identifier leaks', () => {
    expect(auditFieldLabel('field_42')).toBe('Field 42');
    expect(auditFieldLabel('some_new_column')).toBe('Some New Column');
  });
});
