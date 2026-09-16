import { closePool } from './pool.js';
import { one, query, withTransaction, type Queryable } from './query.js';
import { hashPassword } from '../security/password.js';
import {
  STATUSES,
  canTransition,
  canReopen,
  type Status,
} from '../status/status.js';

/**
 * Development seed (R21).
 *
 * ── What this produces ───────────────────────────────────────────────────────
 * A representative dataset that lets a developer exercise the whole application
 * locally, satisfying every clause of Requirement 21:
 *   • R21.1 — at least one administrator (in `admin_group`).
 *   • R21.2 — at least 5 teams, each with a leader, ≥5 members, and ≥3 tasks
 *     (each task versioned via task_version/task_field over seeded data points
 *     spanning all nine data types, R3.1).
 *   • R21.3 — each team leader has 2 team members who are themselves managers of
 *     2 users each (the R19 manager hierarchy). One area manager is seeded so
 *     the R19.2 self-start cutoff is exercisable.
 *   • R21.4 — a selection of users each with several requests across different
 *     teams and task types.
 *   • R21.5 — requests whose status journeys collectively exercise EVERY route
 *     in the R9 state machine (including the constrained raiser reopen edge),
 *     with column-level audit_entry rows recorded for each hop (R17) so the
 *     lifecycle/statistics features have realistic transition data.
 *   • R21.6 — ALL development accounts use the password "password1", stored
 *     HASHED via the project hashing helper (never plaintext).
 * Some `time_slice` rows are recorded against requests that passed through
 * ACTIVE so the effort/time-by-type statistics (R4.7, R10.3, R12) are non-trivial.
 *
 * ── Conventions honoured ─────────────────────────────────────────────────────
 *   • Idempotent / re-runnable: TRUNCATE-and-reseed of every application table
 *     in one transaction (RESTART IDENTITY so ids are stable across runs). The
 *     `schema_migrations` table is never touched.
 *   • Parameterised data-access only (db/query.ts): no value is ever
 *     interpolated into SQL text. Table names in the TRUNCATE come from a
 *     code-controlled constant list, never from input.
 *   • The status state machine (status.ts) is the single source of truth for
 *     which transitions are legal; the seed asserts each journey hop against it
 *     rather than hard-coding the allowed pairs, so it can never drift from R9.
 *   • Runs via `npm run seed` (wired in package.json), mirroring the migration
 *     runner's CLI shape (db/migrate.ts).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tunables (kept at/above the R21 minimums so the "≥" clauses always hold).
// ─────────────────────────────────────────────────────────────────────────────

const PASSWORD = 'password1'; // R21.6 — every dev account; stored hashed only.
// Teams and their task types come from the IT-support catalogue (TEAMS) defined
// below; TEAM_COUNT is derived from it so the two never drift. Each catalogue
// team has ≥3 task types and we seed ≥5 members per team, satisfying R21.2.
const MEMBERS_PER_TEAM = 6; // R21.2 — ≥5 (leader is additionally a member).

/**
 * Every application table, in FK-safe dependency order (children first). Used by
 * {@link truncateAll} so a re-run starts from a clean slate. `schema_migrations`
 * is intentionally excluded — the schema stays; only data is reseeded.
 */
const APP_TABLES: readonly string[] = [
  'audit_entry',
  'request_last_seen',
  'time_slice',
  'active_timer',
  'request_note',
  'request_field_value',
  'request',
  'task_field',
  'task_version',
  'task',
  'data_point',
  'team_member',
  'team',
  'admin_group',
  'area_manager',
  'app_user',
];

// ─────────────────────────────────────────────────────────────────────────────
// Username allocation: usernames are exactly 8 digits (app_user CHECK, R1.2).
// A monotonic counter keeps them unique and deterministic across a run.
// ─────────────────────────────────────────────────────────────────────────────

let nextUsernameSeq = 10_000_000; // first username: "10000000"
function nextUsername(): string {
  const value = String(nextUsernameSeq);
  nextUsernameSeq += 1;
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status journeys (R21.5). Each journey is a start status plus an ordered list
// of subsequent statuses; consecutive pairs are the transitions we want to
// exercise. Collectively these cover every edge in the R9 state machine:
//   NEW→TRIAGE, TRIAGE→ACCEPTED, TRIAGE→REJECTED, ACCEPTED→ASSIGNED,
//   ASSIGNED→ACTIVE, ASSIGNED→PAUSED, ASSIGNED→BLOCKED, PAUSED→ACTIVE,
//   BLOCKED→ACTIVE, ACTIVE→COMPLETE, ACTIVE→PAUSED, ACTIVE→BLOCKED,
//   (any non-stop)→CANCELLED, and the constrained raiser reopen CANCELLED→NEW.
// Every hop is asserted against status.ts before use, so the seed cannot drift
// from the state machine.
// ─────────────────────────────────────────────────────────────────────────────

interface Journey {
  readonly name: string;
  /**
   * Ordered status path; index 0 is the starting status (always NEW). Each
   * consecutive pair is a transition the seed drives and audits. Where a pair is
   * the constrained raiser reopen (CANCELLED→NEW) the seed validates it via
   * {@link canReopen}; all other pairs via {@link canTransition}.
   */
  readonly path: readonly Status[];
}

const JOURNEYS: readonly Journey[] = [
  // Happy path all the way to COMPLETE (exercises NEW→TRIAGE→ACCEPTED→ASSIGNED
  // →ACTIVE→COMPLETE). ACTIVE hop means it earns time slices.
  { name: 'complete', path: ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'ACTIVE', 'COMPLETE'] },
  // Rejected at triage (TRIAGE→REJECTED).
  { name: 'rejected', path: ['NEW', 'TRIAGE', 'REJECTED'] },
  // Assigned then paused then resumed then completed
  // (ASSIGNED→PAUSED, PAUSED→ACTIVE, ACTIVE→COMPLETE).
  { name: 'paused-resumed', path: ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'PAUSED', 'ACTIVE', 'COMPLETE'] },
  // Assigned then blocked then unblocked then completed
  // (ASSIGNED→BLOCKED, BLOCKED→ACTIVE, ACTIVE→COMPLETE).
  { name: 'blocked-resumed', path: ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'BLOCKED', 'ACTIVE', 'COMPLETE'] },
  // Active then paused (ACTIVE→PAUSED) — leaves the request open/paused.
  { name: 'active-paused', path: ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'ACTIVE', 'PAUSED'] },
  // Active then blocked (ACTIVE→BLOCKED) — leaves the request open/blocked.
  { name: 'active-blocked', path: ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'ACTIVE', 'BLOCKED'] },
  // In-flight, currently ACTIVE (earns an open-ended slice of work).
  { name: 'active-open', path: ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'ACTIVE'] },
  // Cancel from each non-stop state, so the "→CANCELLED from any non-stop
  // state" rule (R9.6) is exercised from every source: NEW, TRIAGE, ACCEPTED,
  // ASSIGNED, ACTIVE, PAUSED, BLOCKED.
  { name: 'cancel-from-new', path: ['NEW', 'CANCELLED'] },
  { name: 'cancel-from-triage', path: ['NEW', 'TRIAGE', 'CANCELLED'] },
  { name: 'cancel-from-accepted', path: ['NEW', 'TRIAGE', 'ACCEPTED', 'CANCELLED'] },
  { name: 'cancel-from-assigned', path: ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'CANCELLED'] },
  { name: 'cancel-from-active', path: ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'ACTIVE', 'CANCELLED'] },
  { name: 'cancel-from-paused', path: ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'PAUSED', 'CANCELLED'] },
  { name: 'cancel-from-blocked', path: ['NEW', 'TRIAGE', 'ACCEPTED', 'ASSIGNED', 'BLOCKED', 'CANCELLED'] },
  // Cancelled then reopened by the raiser (CANCELLED→NEW), then re-triaged.
  { name: 'reopened', path: ['NEW', 'CANCELLED', 'NEW', 'TRIAGE'] },
  // A brand-new request that has not moved yet (status NEW).
  { name: 'new-only', path: ['NEW'] },
];

/**
 * The reusable data-point catalogue (R3.1, R14). Deliberately spans every one
 * of the nine data types so requests exercise all field types, while reading
 * like a real IT service-desk field library. Each entry has a stable `key`
 * that the task catalogue below references to compose its fields, plus a
 * representative `sampleValue` used when a task field does not override it.
 */
interface DataPointSeed {
  /** Stable key referenced by the task catalogue (not persisted). */
  readonly key: string;
  readonly name: string;
  readonly dataType:
    | "TEXT"
    | "EMAIL"
    | "DATE"
    | "NUMERIC"
    | "DATETIME"
    | "TIME"
    | "BOOLEAN"
    | "DROPDOWN"
    | "REGEXP";
  readonly description: string;
  readonly defaultHelpText: string;
  readonly regexpPattern?: string;
  readonly defaultOptions?: readonly string[];
  /** A representative valid value used when a task field has no override. */
  readonly sampleValue: string;
}

const DATA_POINTS: readonly DataPointSeed[] = [
  {
    key: "full_name",
    name: "Full Name",
    dataType: "TEXT",
    description: "The full name of the person the request is about",
    defaultHelpText: "Enter the person’s first and last name.",
    sampleValue: "Jordan Smith",
  },
  {
    key: "user_email",
    name: "User Email",
    dataType: "EMAIL",
    description: "The email address of the affected user or account",
    defaultHelpText: "We use this to identify the account and send updates.",
    sampleValue: "jordan.smith@example.com",
  },
  {
    key: "start_date",
    name: "Start Date",
    dataType: "DATE",
    description: "The date the access or change should take effect",
    defaultHelpText: "Pick the date this should be actioned.",
    sampleValue: "2026-04-01",
  },
  {
    key: "affected_users",
    name: "Affected Users",
    dataType: "NUMERIC",
    description: "How many people are impacted by this issue",
    defaultHelpText: "Enter a whole number.",
    sampleValue: "1",
  },
  {
    key: "incident_time",
    name: "Incident Time",
    dataType: "DATETIME",
    description: "When the problem was first observed",
    defaultHelpText: "Pick the date and time the issue started.",
    sampleValue: "2026-01-20T09:30:00.000Z",
  },
  {
    key: "maintenance_window",
    name: "Preferred Maintenance Window",
    dataType: "TIME",
    description: "Preferred time of day to carry out the work",
    defaultHelpText: "Pick a time of day for the change.",
    sampleValue: "22:00",
  },
  {
    key: "business_critical",
    name: "Business Critical",
    dataType: "BOOLEAN",
    description: "Whether this blocks business operations",
    defaultHelpText: "Tick if this is stopping people from working.",
    sampleValue: "true",
  },
  {
    key: "priority",
    name: "Priority",
    dataType: "DROPDOWN",
    description: "Requested priority for this request",
    defaultHelpText: "Choose a priority level.",
    defaultOptions: ["Low", "Medium", "High", "Critical"],
    sampleValue: "High",
  },
  {
    key: "asset_tag",
    name: "Asset Tag",
    dataType: "REGEXP",
    description: "The asset tag of the device (e.g. PC-1234)",
    defaultHelpText: "Format: two/three letters, a dash, four digits.",
    regexpPattern: "^[A-Z]{2,3}-[0-9]{4}$",
    sampleValue: "PC-1234",
  },
  {
    key: "username",
    name: "Account Username",
    dataType: "TEXT",
    description: "The login/username of the affected account",
    defaultHelpText: "Enter the account’s username (not the email).",
    sampleValue: "jsmith",
  },
  {
    key: "department",
    name: "Department",
    dataType: "DROPDOWN",
    description: "The department the request relates to",
    defaultHelpText: "Choose the department.",
    defaultOptions: ["Finance", "Sales", "Engineering", "HR", "Operations", "IT"],
    sampleValue: "Engineering",
  },
  {
    key: "manager_email",
    name: "Approving Manager Email",
    dataType: "EMAIL",
    description: "The manager who approves this request",
    defaultHelpText: "We may contact this manager to confirm approval.",
    sampleValue: "manager@example.com",
  },
  {
    key: "server_name",
    name: "Server Name",
    dataType: "TEXT",
    description: "The hostname of the server involved",
    defaultHelpText: "Enter the server hostname (e.g. app-prod-01).",
    sampleValue: "app-prod-01",
  },
  {
    key: "environment",
    name: "Environment",
    dataType: "DROPDOWN",
    description: "The environment the change applies to",
    defaultHelpText: "Choose the environment.",
    defaultOptions: ["Development", "Test", "Staging", "Production"],
    sampleValue: "Production",
  },
  {
    key: "database_name",
    name: "Database Name",
    dataType: "TEXT",
    description: "The database instance or schema involved",
    defaultHelpText: "Enter the database or schema name.",
    sampleValue: "ORDERS_PROD",
  },
  {
    key: "permission_level",
    name: "Permission Level",
    dataType: "DROPDOWN",
    description: "The level of access being requested",
    defaultHelpText: "Choose the access level required.",
    defaultOptions: ["Read", "Read/Write", "Admin"],
    sampleValue: "Read/Write",
  },
  {
    key: "error_message",
    name: "Error Message",
    dataType: "TEXT",
    description: "The exact error message seen, if any",
    defaultHelpText: "Copy the error text or describe what happened.",
    sampleValue: "Application not responding; screen frozen.",
  },
  {
    key: "cpu_count",
    name: "vCPU Count",
    dataType: "NUMERIC",
    description: "Number of virtual CPUs required",
    defaultHelpText: "Enter the number of vCPUs.",
    sampleValue: "4",
  },
];

/**
 * A field specification within a task: which data point it maps to (by key),
 * whether it is mandatory, and an optional context-specific sample value used
 * when seeding this task type’s request values (falls back to the data point’s
 * default sample when omitted).
 */
interface TaskFieldSpec {
  readonly dataPointKey: string;
  readonly isMandatory: boolean;
  readonly sampleValue?: string;
}

/** A task type within a team (a real IT service-desk request type). */
interface TaskSpec {
  readonly name: string;
  readonly fields: readonly TaskFieldSpec[];
  /** Support notes shown to the support team when working the request. */
  readonly supportNotes: string;
}

/** A support team and the catalogue of task types it handles. */
interface TeamSpec {
  readonly title: string;
  readonly description: string;
  readonly tasks: readonly TaskSpec[];
}

/**
 * The seeded IT-support teams and their task catalogues (R21.2). Six teams,
 * each with several realistic request types whose fields are drawn from the
 * data-point catalogue above. Field selections vary by task so the data spans
 * every data type across the dataset while each task reads true-to-life.
 */
const TEAMS: readonly TeamSpec[] = [
  {
    title: "Service Desk",
    description: "First-line support for staff: accounts, devices and general IT issues.",
    tasks: [
      {
        name: "Unlock User Account",
        supportNotes: "Verify identity via security questions before unlocking. Confirm the account is locked, not disabled.",
        fields: [
          { dataPointKey: "username", isMandatory: true },
          { dataPointKey: "user_email", isMandatory: true },
          { dataPointKey: "business_critical", isMandatory: false },
          { dataPointKey: "priority", isMandatory: false, sampleValue: "Medium" },
        ],
      },
      {
        name: "Password Reset",
        supportNotes: "Confirm the caller’s identity. Issue a temporary password and force change at next logon.",
        fields: [
          { dataPointKey: "username", isMandatory: true },
          { dataPointKey: "user_email", isMandatory: true },
          { dataPointKey: "priority", isMandatory: false, sampleValue: "Medium" },
        ],
      },
      {
        name: "PC Hung / Frozen",
        supportNotes: "Attempt remote reboot first. Capture the asset tag and any error before escalating to desktop support.",
        fields: [
          { dataPointKey: "asset_tag", isMandatory: true },
          { dataPointKey: "full_name", isMandatory: true },
          { dataPointKey: "error_message", isMandatory: false },
          { dataPointKey: "incident_time", isMandatory: false },
          { dataPointKey: "business_critical", isMandatory: false },
        ],
      },
      {
        name: "Software Installation Request",
        supportNotes: "Check licensing and manager approval before installing. Deploy via the software centre where possible.",
        fields: [
          { dataPointKey: "asset_tag", isMandatory: true },
          { dataPointKey: "full_name", isMandatory: true },
          { dataPointKey: "department", isMandatory: false },
          { dataPointKey: "manager_email", isMandatory: false },
        ],
      },
    ],
  },
  {
    title: "Identity & Access Management",
    description: "Provisioning, de-provisioning and access for user accounts and groups.",
    tasks: [
      {
        name: "Create User",
        supportNotes: "Create the account only after manager approval. Apply the standard role template for the department.",
        fields: [
          { dataPointKey: "full_name", isMandatory: true },
          { dataPointKey: "user_email", isMandatory: true },
          { dataPointKey: "department", isMandatory: true },
          { dataPointKey: "manager_email", isMandatory: true },
          { dataPointKey: "start_date", isMandatory: false },
        ],
      },
      {
        name: "Disable Leaver Account",
        supportNotes: "Disable (do not delete) on the leaver’s last working day. Preserve the mailbox for 90 days.",
        fields: [
          { dataPointKey: "username", isMandatory: true },
          { dataPointKey: "full_name", isMandatory: true },
          { dataPointKey: "start_date", isMandatory: true, sampleValue: "2026-04-30" },
          { dataPointKey: "manager_email", isMandatory: false },
        ],
      },
      {
        name: "Grant Group Membership",
        supportNotes: "Confirm the requested group and that manager approval is attached before adding membership.",
        fields: [
          { dataPointKey: "username", isMandatory: true },
          { dataPointKey: "department", isMandatory: true },
          { dataPointKey: "permission_level", isMandatory: false },
          { dataPointKey: "manager_email", isMandatory: true },
        ],
      },
    ],
  },
  {
    title: "Database Administration",
    description: "Care and feeding of database services: availability, access and changes.",
    tasks: [
      {
        name: "Start Database",
        supportNotes: "Confirm the outage and check for an active change freeze before starting the instance.",
        fields: [
          { dataPointKey: "database_name", isMandatory: true },
          { dataPointKey: "environment", isMandatory: true },
          { dataPointKey: "business_critical", isMandatory: false },
          { dataPointKey: "incident_time", isMandatory: false },
        ],
      },
      {
        name: "Grant Permission in Database",
        supportNotes: "Verify least-privilege. Read/Write and Admin grants in Production require manager approval.",
        fields: [
          { dataPointKey: "database_name", isMandatory: true },
          { dataPointKey: "username", isMandatory: true },
          { dataPointKey: "permission_level", isMandatory: true },
          { dataPointKey: "environment", isMandatory: true },
          { dataPointKey: "manager_email", isMandatory: false },
        ],
      },
      {
        name: "Restore Database Backup",
        supportNotes: "Confirm the restore point and target environment. Never restore over Production without change approval.",
        fields: [
          { dataPointKey: "database_name", isMandatory: true },
          { dataPointKey: "environment", isMandatory: true },
          { dataPointKey: "start_date", isMandatory: false },
          { dataPointKey: "priority", isMandatory: false, sampleValue: "Critical" },
        ],
      },
    ],
  },
  {
    title: "Infrastructure & Servers",
    description: "Server provisioning, patching and platform changes across environments.",
    tasks: [
      {
        name: "Create Server",
        supportNotes: "Provision from the approved image. Confirm sizing and environment before building.",
        fields: [
          { dataPointKey: "server_name", isMandatory: true },
          { dataPointKey: "environment", isMandatory: true },
          { dataPointKey: "cpu_count", isMandatory: true },
          { dataPointKey: "maintenance_window", isMandatory: false },
          { dataPointKey: "manager_email", isMandatory: false },
        ],
      },
      {
        name: "Reboot Server",
        supportNotes: "Schedule within the maintenance window. Notify service owners and confirm health after reboot.",
        fields: [
          { dataPointKey: "server_name", isMandatory: true },
          { dataPointKey: "environment", isMandatory: true },
          { dataPointKey: "maintenance_window", isMandatory: false },
          { dataPointKey: "business_critical", isMandatory: false },
        ],
      },
      {
        name: "Extend Disk Space",
        supportNotes: "Check the volume and current utilisation. Snapshot before extending in Production.",
        fields: [
          { dataPointKey: "server_name", isMandatory: true },
          { dataPointKey: "environment", isMandatory: true },
          { dataPointKey: "affected_users", isMandatory: false },
        ],
      },
    ],
  },
  {
    title: "Network & Connectivity",
    description: "Connectivity, firewall and remote-access requests and incidents.",
    tasks: [
      {
        name: "Open Firewall Port",
        supportNotes: "Requires security review. Confirm source, destination and business justification before opening.",
        fields: [
          { dataPointKey: "server_name", isMandatory: true },
          { dataPointKey: "environment", isMandatory: true },
          { dataPointKey: "manager_email", isMandatory: true },
          { dataPointKey: "business_critical", isMandatory: false },
        ],
      },
      {
        name: "VPN Access Request",
        supportNotes: "Confirm manager approval and that the device is corporate-managed before granting VPN.",
        fields: [
          { dataPointKey: "full_name", isMandatory: true },
          { dataPointKey: "user_email", isMandatory: true },
          { dataPointKey: "department", isMandatory: false },
          { dataPointKey: "manager_email", isMandatory: true },
        ],
      },
      {
        name: "Investigate Network Outage",
        supportNotes: "Capture scope and start time. Check monitoring and escalate to on-call if multiple sites affected.",
        fields: [
          { dataPointKey: "affected_users", isMandatory: true, sampleValue: "45" },
          { dataPointKey: "incident_time", isMandatory: true },
          { dataPointKey: "business_critical", isMandatory: false },
          { dataPointKey: "priority", isMandatory: false, sampleValue: "Critical" },
        ],
      },
    ],
  },
  {
    title: "Applications Support",
    description: "Support and change requests for business applications.",
    tasks: [
      {
        name: "Application Error Investigation",
        supportNotes: "Reproduce where possible. Capture the exact error and time, and check recent releases.",
        fields: [
          { dataPointKey: "error_message", isMandatory: true },
          { dataPointKey: "incident_time", isMandatory: true },
          { dataPointKey: "affected_users", isMandatory: false },
          { dataPointKey: "business_critical", isMandatory: false },
        ],
      },
      {
        name: "New Application Access",
        supportNotes: "Confirm licence availability and manager approval, then assign the appropriate role.",
        fields: [
          { dataPointKey: "full_name", isMandatory: true },
          { dataPointKey: "user_email", isMandatory: true },
          { dataPointKey: "permission_level", isMandatory: false },
          { dataPointKey: "manager_email", isMandatory: true },
        ],
      },
      {
        name: "Schedule Application Deployment",
        supportNotes: "Book the change window and confirm rollback plan before deploying to Production.",
        fields: [
          { dataPointKey: "server_name", isMandatory: true },
          { dataPointKey: "environment", isMandatory: true },
          { dataPointKey: "maintenance_window", isMandatory: true },
          { dataPointKey: "start_date", isMandatory: false },
        ],
      },
    ],
  },
];

/** Number of teams to seed (derived from the catalogue so they never drift). */
const TEAM_COUNT = TEAMS.length; // R21.2 — ≥5.

/** Total task types across all teams (used for a sanity assertion). */
const TOTAL_TASK_TYPES = TEAMS.reduce((n, team) => n + team.tasks.length, 0);


// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Titlecase-free deterministic display-name parts for seeded people. */
const FIRST_NAMES = [
  'Alex', 'Bailey', 'Casey', 'Dana', 'Ellis', 'Frankie', 'Gray', 'Harper',
  'Indi', 'Jordan', 'Kai', 'Lee', 'Morgan', 'Noor', 'Ola', 'Parker', 'Quinn',
  'Riley', 'Sam', 'Toni', 'Val', 'Wren', 'Yuki', 'Zane',
];
const SURNAMES = [
  'Adams', 'Brooks', 'Clarke', 'Diaz', 'Evans', 'Fisher', 'Gomez', 'Hughes',
  'Ito', 'Jones', 'Khan', 'Lewis', 'Mensah', 'Novak', 'Owens', 'Patel',
  'Reid', 'Singh', 'Taylor', 'Ueda', 'Vega', 'Walsh', 'Yang', 'Zhang',
];

let nameSeq = 0;
function nextName(): { firstName: string; surname: string } {
  const firstName = FIRST_NAMES[nameSeq % FIRST_NAMES.length]!;
  const surname = SURNAMES[Math.floor(nameSeq / FIRST_NAMES.length) % SURNAMES.length]!;
  nameSeq += 1;
  return { firstName, surname };
}

/** A `timestamptz` offset `daysAgo` days before now (for spread-out data). */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Insert helpers (all parameterised)
// ─────────────────────────────────────────────────────────────────────────────

interface SeededUser {
  readonly id: number;
  readonly username: string;
  readonly firstName: string;
  readonly surname: string;
}

async function truncateAll(tx: Queryable): Promise<void> {
  // Table names are a code-controlled constant list (never input); TRUNCATE
  // cannot use bound identifiers, so they are joined directly here — safe.
  const list = APP_TABLES.join(', ');
  await query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`, [], tx);
}

async function insertUser(
  tx: Queryable,
  passwordHash: string,
  managerId: number | null,
): Promise<SeededUser> {
  const { firstName, surname } = nextName();
  const username = nextUsername();
  const row = await one<{ id: string | number }>(
    `INSERT INTO app_user
       (username, first_name, surname, email, manager_id, password_hash, timezone)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      username,
      firstName,
      surname,
      `${username}@example.com`,
      managerId,
      passwordHash,
      'Europe/London',
    ],
    tx,
  );
  return { id: Number(row!.id), username, firstName, surname };
}

async function addAdmin(tx: Queryable, userId: number): Promise<void> {
  await query('INSERT INTO admin_group (user_id) VALUES ($1)', [userId], tx);
}

async function addAreaManager(tx: Queryable, userId: number): Promise<void> {
  await query('INSERT INTO area_manager (user_id) VALUES ($1)', [userId], tx);
}

async function insertTeam(
  tx: Queryable,
  title: string,
  description: string,
  leaderId: number,
): Promise<number> {
  const row = await one<{ id: string | number }>(
    `INSERT INTO team (title, description, team_leader_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [title, description, leaderId],
    tx,
  );
  return Number(row!.id);
}

async function addTeamMember(
  tx: Queryable,
  teamId: number,
  userId: number,
): Promise<void> {
  await query(
    `INSERT INTO team_member (team_id, user_id) VALUES ($1, $2)
     ON CONFLICT (team_id, user_id) DO NOTHING`,
    [teamId, userId],
    tx,
  );
}

interface SeededDataPoint extends DataPointSeed {
  readonly id: number;
}

async function insertDataPoints(tx: Queryable): Promise<SeededDataPoint[]> {
  const seeded: SeededDataPoint[] = [];
  for (const dp of DATA_POINTS) {
    const row = await one<{ id: string | number }>(
      `INSERT INTO data_point
         (name, data_type, description, default_help_text, regexp_pattern, default_options)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        dp.name,
        dp.dataType,
        dp.description,
        dp.defaultHelpText,
        dp.regexpPattern ?? null,
        dp.defaultOptions ? JSON.stringify(dp.defaultOptions) : null,
      ],
      tx,
    );
    seeded.push({ ...dp, id: Number(row!.id) });
  }
  return seeded;
}

interface SeededTaskField {
  readonly id: number;
  readonly dataPoint: SeededDataPoint;
  /** The value seeded into request_field_value for this field (task-specific). */
  readonly sampleValue: string;
}

interface SeededTask {
  readonly id: number;
  readonly name: string;
  readonly teamId: number;
  readonly versionId: number;
  readonly fields: readonly SeededTaskField[];
}

/**
 * Create a task type from its catalogue {@link TaskSpec}: one current
 * task_version (carrying the task’s support notes) and its ordered task_fields,
 * each mapped to a data point by key with the spec’s mandatory flag (R16). At
 * least one field per task is mandatory by construction of the catalogue, so
 * every request has a required value.
 */
async function insertTask(
  tx: Queryable,
  teamId: number,
  spec: TaskSpec,
  dpByKey: ReadonlyMap<string, SeededDataPoint>,
): Promise<SeededTask> {
  const taskRow = await one<{ id: string | number }>(
    `INSERT INTO task (team_id, name) VALUES ($1, $2) RETURNING id`,
    [teamId, spec.name],
    tx,
  );
  const taskId = Number(taskRow!.id);

  const versionRow = await one<{ id: string | number }>(
    `INSERT INTO task_version (task_id, version_no, support_notes)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [taskId, 1, spec.supportNotes],
    tx,
  );
  const versionId = Number(versionRow!.id);

  const fields: SeededTaskField[] = [];
  let order = 1;
  for (const fieldSpec of spec.fields) {
    const dp = dpByKey.get(fieldSpec.dataPointKey);
    if (!dp) {
      throw new Error(
        `Task "${spec.name}" references unknown data point key "${fieldSpec.dataPointKey}"`,
      );
    }
    const fieldRow = await one<{ id: string | number }>(
      `INSERT INTO task_field
         (task_version_id, data_point_id, field_order, is_mandatory, options_override)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [versionId, dp.id, order, fieldSpec.isMandatory, null],
      tx,
    );
    fields.push({
      id: Number(fieldRow!.id),
      dataPoint: dp,
      sampleValue: fieldSpec.sampleValue ?? dp.sampleValue,
    });
    order += 1;
  }

  await query(
    `UPDATE task SET current_version_id = $1 WHERE id = $2`,
    [versionId, taskId],
    tx,
  );

  return { id: taskId, name: spec.name, teamId, versionId, fields };
}

let referenceSeq = 0;
/** Deterministic, unique human-facing request reference (R2.14). */
function nextReference(): string {
  referenceSeq += 1;
  return `REQ-${String(referenceSeq).padStart(5, '0')}`;
}

/**
 * Record one column-level audit row for a status change (R17). Uses the raw
 * parameterised INSERT (mirroring audit-writer's shape) with an explicit
 * `changed_at` so the transition timeline is spread realistically.
 */
async function auditStatusChange(
  tx: Queryable,
  requestId: number,
  changedById: number,
  from: string | null,
  to: string,
  changedAt: Date,
): Promise<void> {
  await query(
    `INSERT INTO audit_entry
       (entity_type, entity_id, field_name, old_value, new_value, changed_by_id, changed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['request', requestId, 'status', from, to, changedById, changedAt],
    tx,
  );
}

async function insertTimeSlice(
  tx: Queryable,
  requestId: number,
  memberId: number,
  minutes: number,
  startedAt: Date,
): Promise<void> {
  const endedAt = new Date(startedAt.getTime() + minutes * 60 * 1000);
  await query(
    `INSERT INTO time_slice (request_id, member_id, started_at, ended_at, duration_minutes)
     VALUES ($1, $2, $3, $4, $5)`,
    [requestId, memberId, startedAt, endedAt, minutes],
    tx,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The seed run
// ─────────────────────────────────────────────────────────────────────────────

/** Counts returned for the smoke assertion and the CLI summary. */
export interface SeedResult {
  readonly admins: number;
  readonly teams: number;
  readonly users: number;
  readonly tasks: number;
  readonly requests: number;
  readonly timeSlices: number;
  readonly transitionRoutes: number;
  readonly statusChanges: number;
}

/**
 * Seed the database (R21). Idempotent: truncates every application table and
 * reseeds, all inside one transaction, so a partial failure leaves the previous
 * data intact. Returns counts used by the smoke assertion / CLI summary.
 */
export async function runSeed(): Promise<SeedResult> {
  const passwordHash = await hashPassword(PASSWORD); // R21.6 — hashed once, reused.

  // Track every distinct transition route we exercise, so we can assert full
  // coverage of the R9 state machine at the end (R21.5).
  const routesCovered = new Set<string>();
  const routeKey = (from: string, to: string): string => `${from}->${to}`;

  return withTransaction(async (tx) => {
    await truncateAll(tx);

    // ── R21.1: at least one administrator ────────────────────────────────────
    const admin = await insertUser(tx, passwordHash, null);
    await addAdmin(tx, admin.id);

    const dataPoints = await insertDataPoints(tx);
    // Key -> seeded data point, so the task catalogue can compose fields by key.
    const dpByKey = new Map<string, SeededDataPoint>(
      dataPoints.map((dp) => [dp.key, dp]),
    );

    // Pools we accumulate across teams for cross-team request raising (R21.4).
    const allTeams: SeededTask[] = []; // flattened task list across teams
    // Seeded team ids, in catalogue order, so request raising can spread across
    // DIFFERENT teams even though teams have varying task counts.
    const teamIds: number[] = [];
    // Each team's task types (parallel to teamIds) for cross-team request picks.
    const tasksByTeam: SeededTask[][] = [];
    const requesterUsers: SeededUser[] = []; // users who raise requests
    const teamMembersByTeam = new Map<number, SeededUser[]>();
    let areaManagerAssigned = false;

    // ── R21.2 / R21.3: teams, leaders, members, sub-managers, users ──────────
    for (let t = 0; t < TEAM_COUNT; t += 1) {
      const teamSpec = TEAMS[t]!;
      const leader = await insertUser(tx, passwordHash, admin.id);
      const teamId = await insertTeam(
        tx,
        teamSpec.title,
        teamSpec.description,
        leader.id,
      );
      teamIds.push(teamId);
      const members: SeededUser[] = [leader];
      await addTeamMember(tx, teamId, leader.id);

      // R21.3: two of the leader's members are managers of 2 users each.
      // Seed those two "sub-manager" members first; they report to the leader.
      for (let m = 0; m < 2; m += 1) {
        const subManager = await insertUser(tx, passwordHash, leader.id);
        members.push(subManager);
        await addTeamMember(tx, teamId, subManager.id);

        // One of the sub-managers on the first team is an area manager (R19.2).
        if (!areaManagerAssigned) {
          await addAreaManager(tx, subManager.id);
          areaManagerAssigned = true;
        }

        // Each sub-manager manages 2 users (plain requesters, R21.3).
        for (let u = 0; u < 2; u += 1) {
          const managed = await insertUser(tx, passwordHash, subManager.id);
          requesterUsers.push(managed);
        }
        // The sub-manager also raises requests themselves (R21.4).
        requesterUsers.push(subManager);
      }

      // Fill up to MEMBERS_PER_TEAM ordinary support members (R21.2 ≥5).
      while (members.length < MEMBERS_PER_TEAM) {
        const member = await insertUser(tx, passwordHash, leader.id);
        members.push(member);
        await addTeamMember(tx, teamId, member.id);
        requesterUsers.push(member);
      }
      teamMembersByTeam.set(teamId, members);

      // R21.2: the team's catalogue task types (each >=3), versioned with their
      // typed fields and the task's support notes.
      const teamTasks: SeededTask[] = [];
      for (const taskSpec of teamSpec.tasks) {
        const task = await insertTask(tx, teamId, taskSpec, dpByKey);
        allTeams.push(task);
        teamTasks.push(task);
      }
      tasksByTeam.push(teamTasks);
    }

    // ── R21.4 / R21.5: requests across teams & types, spanning all routes ────
    let requestCount = 0;
    let timeSliceCount = 0;
    let statusChangeCount = 0;

    // Give each requester several requests spanning DIFFERENT teams and task
    // types (R21.4). Teams and their task lists are tracked separately, so each
    // of a user's requests targets a different team and rotates through that
    // team's task types. Journeys advance globally so all routes get run.
    let journeyIdx = 0;
    let userIdx = 0;
    const REQUESTS_PER_USER = 4; // "several", each in a different team (R21.4).

    for (const requester of requesterUsers) {
      for (let r = 0; r < REQUESTS_PER_USER; r += 1) {
        // Cross-team spread: pick a DIFFERENT team per request (advancing one
        // team per step from a per-user offset), then a task within that team
        // (rotating so users draw varied task types). Teams have varying task
        // counts, so we index each team's own task list (R21.4).
        const teamPos = (userIdx + r) % teamIds.length;
        const teamTasks = tasksByTeam[teamPos]!;
        const task = teamTasks[(userIdx + r) % teamTasks.length]!;
        const journey = JOURNEYS[journeyIdx % JOURNEYS.length]!;
        journeyIdx += 1;

        const members = teamMembersByTeam.get(task.teamId)!;
        const assignee = members[(r + userIdx) % members.length]!;

        const created = daysAgo(60 - (requestCount % 55));
        const reference = nextReference();

        // Insert the request at NEW; we then walk it along its journey, writing
        // the audit trail and (finally) setting its resting status.
        const finalStatus = journey.path[journey.path.length - 1]!;
        const assignedMemberId =
          journey.path.includes('ASSIGNED') ||
          journey.path.includes('ACTIVE')
            ? assignee.id
            : null;

        const reqRow = await one<{ id: string | number }>(
          `INSERT INTO request
             (task_reference, task_version_id, title, raised_by_id, team_id,
              assigned_member_id, status, jira_number, estimated_start_date,
              actual_start_date, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
           RETURNING id`,
          [
            reference,
            task.versionId,
            `${task.name} for ${requester.firstName} ${requester.surname}`,
            requester.id,
            task.teamId,
            assignedMemberId,
            finalStatus,
            r % 2 === 0 ? `JIRA-${1000 + requestCount}` : null,
            journey.path.includes('ASSIGNED') ? daysAgo(30) : null,
            journey.path.includes('ACTIVE') ? daysAgo(20) : null,
            created,
          ],
          tx,
        );
        const requestId = Number(reqRow!.id);
        requestCount += 1;

        // Persist field values for the task's fields (R2.14) so requests carry
        // realistic, type-valid data across all data types (R3.1).
        for (const field of task.fields) {
          await query(
            `INSERT INTO request_field_value (request_id, task_field_id, value)
             VALUES ($1, $2, $3)`,
            [requestId, field.id, field.sampleValue],
            tx,
          );
        }

        // Walk the status journey, asserting each hop against the state machine
        // (R9) and writing a status audit_entry per transition (R17, R21.5).
        let hopTime = created;
        for (let i = 1; i < journey.path.length; i += 1) {
          const from = journey.path[i - 1]!;
          const to = journey.path[i]!;
          const isReopen = from === 'CANCELLED' && to === 'NEW';
          const legal = isReopen
            ? canReopen(from, to)
            : canTransition(from, to);
          if (!legal) {
            throw new Error(
              `Seed journey "${journey.name}" has an illegal transition ${from}->${to}`,
            );
          }
          hopTime = new Date(hopTime.getTime() + 60 * 60 * 1000); // +1h per hop
          // Cancels/reopens are attributed to the raiser (R5.5–5.7); other hops
          // to the assigned support member (or leader as a fallback).
          const actorId =
            to === 'CANCELLED' || isReopen
              ? requester.id
              : assignee.id;
          await auditStatusChange(tx, requestId, actorId, from, to, hopTime);
          statusChangeCount += 1;
          routesCovered.add(routeKey(from, to));
        }

        // Record time slices for any request that passed through ACTIVE, so the
        // effort/time-by-type stats are non-trivial (R4.7, R10.3, R12).
        if (journey.path.includes('ACTIVE')) {
          const activeStart = new Date(created.getTime() + 3 * 60 * 60 * 1000);
          await insertTimeSlice(tx, requestId, assignee.id, 45 + (r * 15), activeStart);
          timeSliceCount += 1;
          // A second member sometimes logs time too (R8.7).
          if (r % 2 === 0 && members.length > 1) {
            const other = members[(members.length - 1)]!;
            await insertTimeSlice(
              tx,
              requestId,
              other.id,
              30,
              new Date(activeStart.getTime() + 2 * 60 * 60 * 1000),
            );
            timeSliceCount += 1;
          }
        }

        // A couple of notes (external + internal) for detail-screen realism.
        await query(
          `INSERT INTO request_note (request_id, author_id, is_internal, body)
           VALUES ($1, $2, false, $3)`,
          [requestId, requester.id, 'Thanks for picking this up.'],
          tx,
        );
        if (assignedMemberId) {
          await query(
            `INSERT INTO request_note (request_id, author_id, is_internal, body)
             VALUES ($1, $2, true, $3)`,
            [requestId, assignee.id, 'Internal: awaiting vendor confirmation.'],
            tx,
          );
        }
      }
      userIdx += 1;
    }

    // Sanity: every catalogue task type was created (teams x their tasks).
    if (allTeams.length !== TOTAL_TASK_TYPES) {
      throw new Error(
        `Seed created ${allTeams.length} task types but the catalogue defines ${TOTAL_TASK_TYPES}`,
      );
    }

    // ── R21.5 assertion: confirm every state-machine route was exercised ─────
    const expectedRoutes = enumerateAllRoutes();
    const missing = expectedRoutes.filter((route) => !routesCovered.has(route));
    if (missing.length > 0) {
      throw new Error(
        `Seed did not exercise all status transition routes; missing: ${missing.join(', ')}`,
      );
    }

    const admins = 1;
    return {
      admins,
      teams: TEAM_COUNT,
      users: nameSeq, // total app_user rows created this run
      tasks: allTeams.length,
      requests: requestCount,
      timeSlices: timeSliceCount,
      transitionRoutes: routesCovered.size,
      statusChanges: statusChangeCount,
    } satisfies SeedResult;
  });
}

/**
 * Enumerate every directed route in the R9 state machine (general transitions
 * plus the constrained raiser reopen CANCELLED→NEW), derived from status.ts so
 * the coverage assertion tracks the state machine automatically.
 */
export function enumerateAllRoutes(): string[] {
  const routes: string[] = [];
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (from === to) continue;
      if (canTransition(from, to) || canReopen(from, to)) {
        routes.push(`${from}->${to}`);
      }
    }
  }
  return routes;
}

/** CLI entry point: `npm run seed`. Mirrors db/migrate.ts's shape. */
async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('Seeding development data (R21)…');
  try {
    const result = await runSeed();
    // eslint-disable-next-line no-console
    console.log(
      'Seed complete:\n' +
        `  administrators : ${result.admins}\n` +
        `  teams          : ${result.teams}\n` +
        `  users          : ${result.users}\n` +
        `  tasks          : ${result.tasks}\n` +
        `  requests       : ${result.requests}\n` +
        `  time slices    : ${result.timeSlices}\n` +
        `  status changes : ${result.statusChanges}\n` +
        `  transition routes exercised : ${result.transitionRoutes} ` +
        `(of ${enumerateAllRoutes().length})`,
    );
  } finally {
    await closePool();
  }
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Seed run failed:', err);
    process.exitCode = 1;
  });
}
