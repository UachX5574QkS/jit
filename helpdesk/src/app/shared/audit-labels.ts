/**
 * Human-friendly labels for audit-trail entries.
 *
 * Audit rows record the raw database column that changed (e.g. `status`,
 * `assigned_member_id`, `jira_number`). Those column names are an INTERNAL
 * concern and mean nothing to an end user, so the detail screens present a
 * readable title instead. Anything without an explicit mapping falls back to a
 * "Title Case" of the raw name so a newly-audited column still reads sensibly
 * rather than showing a snake_case identifier.
 */

/** Known audit field-name → display-title mappings (request + note columns). */
const AUDIT_FIELD_LABELS: Readonly<Record<string, string>> = {
  status: 'Status',
  assigned_member_id: 'Assigned To',
  raised_by_id: 'Raised By',
  team_id: 'Team',
  task_version_id: 'Task',
  task_reference: 'Reference',
  jira_number: 'Jira',
  estimated_start_date: 'Estimated Start',
  actual_start_date: 'Actual Start',
  body: 'Note',
  is_internal: 'Internal Note',
  title: 'Title',
};

/**
 * Convert a raw audit `field_name` into a user-facing title. Known columns use
 * a curated label; a `field_<n>` value-change key or any other snake_case name
 * degrades to Title Case (e.g. `some_new_column` → "Some New Column").
 */
export function auditFieldLabel(fieldName: string): string {
  const known = AUDIT_FIELD_LABELS[fieldName];
  if (known) {
    return known;
  }
  return fieldName
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
