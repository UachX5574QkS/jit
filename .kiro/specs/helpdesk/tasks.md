# Implementation Plan

Tasks are ordered so that each builds on the previous: schema first, then the backend contract and cross-cutting logic, then the shared UI foundation, then features in dependency order. Each task lists the requirements it satisfies. Every backend behaviour task includes its own tests per the design's testing strategy.

- [x] 1. Project scaffolding and local runtime
  - [x] 1.1 Create the standalone Angular project under `helpdesk/` (latest Angular, standalone components, routing) — separate from the existing React `frontend/`.
    - _Requirements: R22.1_
  - [x] 1.2 Create the Node/Express backend project with a JSON API skeleton, config for the local `helpdesk` Postgres connection, and a dev script that runs frontend + backend together on the laptop.
    - _Requirements: R22.2, R22.3, R22.4_
  - [x] 1.3 Add a parameterised query/data-access layer (no string-interpolated SQL) and a migration runner.
    - _Requirements: R22.2, R22.4_

- [x] 2. Database schema and migrations
  - [x] 2.1 Create identity/org tables: `app_user`, `area_manager`, `admin_group` (all timestamps `timestamptz`).
    - _Requirements: R1, R18.1, R19.2, R19.3_
  - [x] 2.2 Create `team` and `team_member`.
    - _Requirements: R13, R15, R20_
  - [x] 2.3 Create `data_point`, `task`, `task_version`, `task_field` (versioned task model).
    - _Requirements: R14, R16_
  - [x] 2.4 Create `request`, `request_field_value`, `request_note`.
    - _Requirements: R2, R4, R5, R7_
  - [x] 2.5 Create `time_slice` and `active_timer` (unique open-timer per request/member).
    - _Requirements: R8_
  - [x] 2.6 Create `audit_entry` (column-level) and `request_last_seen`.
    - _Requirements: R17, R4.8, R5.2_
  - [x] 2.7 Add the `status` enum and stop-state definitions.
    - _Requirements: R9.1, R9.3_

- [x] 3. Cross-cutting backend services
  - [x] 3.1 Implement password hashing (bcrypt/argon2) helpers; ensure hashes are never returned or logged.
    - _Requirements: R1.5_
  - [x] 3.2 Implement the `CurrentUser` resolver (dev session cookie now; abstraction ready for IDCS) exposing id, roles, teams led, teams member of, isAdmin, timezone.
    - _Requirements: R1.3, R1.7, R1.8, R22.4_
  - [x] 3.3 Implement role-based authorisation middleware enforced on every endpoint; write tests for each role boundary.
    - _Requirements: R1.8_
  - [x] 3.4 Implement the column-level audit writer that runs in the same transaction as any mutation.
    - _Requirements: R17.1, R17.2_
  - [x] 3.5 Implement the status state machine (allowed transitions, COMPLETE-only-from-ACTIVE, cancel-from-any-non-stop) with unit tests for allowed and blocked transitions.
    - _Requirements: R9_
  - [x] 3.6 Implement the manager-hierarchy resolver with area-manager cutoff and cycle termination; unit test both.
    - _Requirements: R19_
  - [x] 3.7 Implement server-side field validation per data type (Text, Email, Date, Numeric, Date+Time, Time, Boolean, Dropdown, Regexp) and mandatory rules; unit test each type incl. regexp/email/numeric.
    - _Requirements: R3_
  - [x] 3.8 Implement the uniform error model and error codes (INVALID_TRANSITION, MANDATORY_FIELD, VALIDATION_FAILED, FORBIDDEN, CONFLICT_OPEN_REQUESTS, TIMER_MIN_DURATION).
    - _Requirements: R3, R5.4, R8.5, R9.7, R20_

- [x] 4. Authentication endpoints and dev login
  - [x] 4.1 Implement `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` with HTTP-only session cookie.
    - _Requirements: R1.1, R1.3, R1.4, R1.7_
  - [x] 4.2 Implement `GET /api/auth/users` (dev-only) for the login drop-down formatting.
    - _Requirements: R1.2_

- [x] 5. Reference data APIs (admin + team leader)
  - [x] 5.1 Team admin: create/list, change leader, close (guarded by open requests).
    - _Requirements: R13, R20.2_
  - [x] 5.2 Data point admin: create (name, description, data type, default help text, options/regexp), list, retire (with retirement rules).
    - _Requirements: R14, R20.4_
  - [x] 5.3 Team-leader team management: update details, change membership, member-removal guard for non-closed requests.
    - _Requirements: R15, R20.3_
  - [x] 5.4 Team-leader task management: create/new-version tasks, field order/fields/dropdown overrides/support notes, override description+help but not name/data type, retire task; version pinning on edit.
    - _Requirements: R16, R20.4_

- [x] 6. Request lifecycle APIs
  - [x] 6.1 Workflow support: list open teams, list active tasks for a team, get current task version fields.
    - _Requirements: R2.3, R2.5–2.8, R3.5_
  - [x] 6.2 `POST /api/review/summary` calling Ollama server-side with short timeout and `{available:false}` fallback; display-only, not persisted.
    - _Requirements: R2.11, R2.12_
  - [x] 6.3 `POST /api/requests` — create with unique reference, status NEW, pinned task version, timestamps.
    - _Requirements: R2.14_
  - [x] 6.4 `GET /api/requests/{id}` — detail with audit trail; exclude internal notes for non-support viewers; record `last_seen`.
    - _Requirements: R5.1, R5.2, R17.4_
  - [x] 6.5 User-side mutations: update Jira + user fields (mandatory not blankable), add note, cancel (raiser/non-stop), reopen (raiser-who-cancelled), clone draft.
    - _Requirements: R5.3–5.8_
  - [x] 6.6 `GET /api/requests` list with mine/team scope, hide-complete, search; hierarchy-scoped for "My Team".
    - _Requirements: R4.1–4.4, R4.9, R19_
  - [x] 6.7 Estimated-effort endpoint (sum of completed-request slices ÷ completed count, per task type).
    - _Requirements: R4.7_
  - [x] 6.8 "Updated" indicator computation from `request_last_seen` vs non-internal changes.
    - _Requirements: R4.8, R7.5, R7.6_

- [x] 7. Support and time-tracking APIs
  - [x] 7.1 Support list endpoint with team drop-down, mine/team-queue, hide-complete, show-unassigned, search.
    - _Requirements: R6_
  - [x] 7.2 Support mutations: update any field + status (state-machine checked) + assignment (any member → any member).
    - _Requirements: R7.1, R7.2, R9_
  - [x] 7.3 Internal vs external notes with correct "Updated"-trigger behaviour (internal update shows on support screen only).
    - _Requirements: R7.3–7.6_
  - [x] 7.4 Timer start (ACTIVE-only), concurrent-timer prompt resolution, timer stop with duration edit (>1 min), record slice with member; auto-stop-and-record on leaving ACTIVE.
    - _Requirements: R8_

- [x] 8. Statistics APIs
  - [x] 8.1 User statistics: status-by-month (viewer timezone), type pie, time-by-type pie, summary table with New→Triage and Triage→Complete averages (exclude Rejected/Cancelled).
    - _Requirements: R10, R18.3_
  - [x] 8.2 Team statistics: same, hierarchy-scoped.
    - _Requirements: R11, R19_
  - [x] 8.3 Support statistics: team selector + All Teams, status-by-month, assigned-count table (Task or Team-Task rows × members), Accepted→Complete average-duration table (exclude Rejected/Cancelled).
    - _Requirements: R12_

- [x] 9. Shared frontend foundation
  - [x] 9.1 Implement the `ui-foundations` shell: 108px icon sidebar, top header (search, dark-mode toggle), content cards, footer, responsive breakpoints, reduced-motion, dark-mode persisted to localStorage.
    - _Requirements: R22.1_
  - [x] 9.2 Implement `CurrentUserService`, HTTP interceptor (auth + error model), and role-based route guards; render menu from role superset.
    - _Requirements: R1.7, R1.8_
  - [x] 9.3 Implement the browser-local date pipe and timezone handling used across screens.
    - _Requirements: R18.2, R18.3_
  - [x] 9.4 Implement shared form-field components honouring data types (incl. date/date-time pickers) and the "?" help affordance, plus chart wrappers (stacked bar, pie).
    - _Requirements: R2.6, R2.7, R3_

- [x] 10. Login and New workflow (frontend)
  - [x] 10.1 Login screen with dev drop-down; establish session; load CurrentUser.
    - _Requirements: R1.1, R1.2_
  - [x] 10.2 New workflow Step 1 (team → task), Step 2 (typed fields, mandatory/type gating, Jira field), Step 3 (Ollama summary with fallback), Submit.
    - _Requirements: R2, R3_

- [x] 11. Requests screen (frontend)
  - [x] 11.1 List with search, My Requests/My Team toggle, Hide Complete, all columns incl. "(Working On)" and "Updated".
    - _Requirements: R4_
  - [x] 11.2 Detail view: full info + audit (internal notes hidden), notes, user-field edits, Cancel/Reopen/Clone.
    - _Requirements: R5_

- [x] 12. Support screen (frontend)
  - [x] 12.1 Queue with team drop-down, My Queue/Team Queue toggle, Hide Complete, Show Unassigned, search.
    - _Requirements: R6_
  - [x] 12.2 Detail: full editing incl. status via state machine, assignment, internal/external notes.
    - _Requirements: R7, R9_
  - [x] 12.3 Timer UI: "Working on It"/"Back to Queue" (ACTIVE-only), duration pop-up with editable value, concurrent-timer prompt.
    - _Requirements: R8_

- [x] 13. Statistics screens (frontend)
  - [x] 13.1 User Statistics dashboard.
    - _Requirements: R10_
  - [x] 13.2 Team Statistics dashboard.
    - _Requirements: R11_
  - [x] 13.3 Support Statistics dashboard.
    - _Requirements: R12_

- [x] 14. Administer screens (frontend)
  - [x] 14.1 Tool Administrator tiles: Teams management, Data Points management.
    - _Requirements: R13, R14_
  - [x] 14.2 Team Leader tiles: Teams membership, Tasks (create/version/retire).
    - _Requirements: R15, R16_

- [x] 15. Development seed data
  - [x] 15.1 Seed script: ≥1 administrator; ≥5 teams each with a leader, ≥5 members, ≥3 tasks; each leader has 2 members who each manage 2 users; users with several requests across teams/types; requests spanning statuses that exercise all transition routes; all passwords "password1" hashed.
    - _Requirements: R21_

- [x] 16. End-to-end verification
  - [x] 16.1 Verify reference-data guards end-to-end (close team / remove member / retire blocked by open requests).
    - _Requirements: R20_
  - [x] 16.2 Verify the full status lifecycle and raiser cancel/reopen paths through the UI against seeded data.
    - _Requirements: R5, R9_
  - [x] 16.3 Verify timezone rendering and month bucketing across screens and statistics.
    - _Requirements: R18_

- [ ] 17. Unknown/Unlisted, Change Type, and Closure flows
  - [ ] 17.1 Schema/migration: add `task.is_unknown_unlisted` and seed a non-retirable "Unknown/Unlisted" system task (with a single `task_version`, no `task_field` rows) per team; add `request.details_text` (nullable); add `task_version.support_instructions`; add `request_note.is_system_generated` (default false).
    - _Requirements: R23.1, R23.2, R23.4, R24.6, R25.2_
  - [ ] 17.2 Extend `GET /api/teams/{id}/tasks?active=true` to include each team's Unknown/Unlisted system task (flagged `isUnknownUnlisted:true`) and suppress it for closed teams; unit test open vs closed teams.
    - _Requirements: R23.1, R23.2_
  - [ ] 17.3 Extend `POST /api/requests` to accept an Unknown/Unlisted submission (`detailsText` mandatory + optional `jiraNumber`) instead of typed field values; persist `details_text`, pin the Unknown/Unlisted `task_version`, set status NEW, write audit; reject a missing/blank Details with `MANDATORY_FIELD`.
    - _Requirements: R23.4, R23.6, R23.7_
  - [ ] 17.4 Add `ACKNOWLEDGE_REQUIRED` and `FINAL_NOTE_REQUIRED` error codes to the uniform error model.
    - _Requirements: R23.3, R25.1_
  - [ ]* 17.5 Backend tests for the Unknown/Unlisted path: task-list inclusion/exclusion, mandatory Details validation, persistence of `details_text`, type marking, and audit entry on creation.
    - _Requirements: R23_
  - [ ] 17.6 Implement `GET /api/requests/{id}/change-type/preview?newTaskId=` returning the side-by-side mapping (current fields/values left, new type's current-version fields right) with matches auto-populated by `data_point_id` and unmatched fields blank.
    - _Requirements: R24.3, R24.4_
  - [ ] 17.7 Implement `POST /api/requests/{id}/change-type` (`{newTaskId, values}`): validate the new type's mandatory/type rules, swap `request.task_version_id` to the new type's current version, replace `request_field_value` rows on the same request, and audit the type change and every field-value change.
    - _Requirements: R24.5, R24.6, R24.8_
  - [ ] 17.8 Implement the auto-generated customer-visible before/after change-type note (external `request_note` with `is_system_generated=true`) written within the change-type transaction.
    - _Requirements: R24.7_
  - [ ]* 17.9 Backend tests for Change Type: preview auto-population by data point, mandatory/type enforcement, version swap/pin, field-value replacement, generated before/after note, and audit coverage.
    - _Requirements: R24_
  - [ ] 17.10 Implement `PATCH /api/task-versions/{id}/support-instructions` for in-place update of the current version's `support_instructions`; audit the change.
    - _Requirements: R25.2, R25.3, R25.6_
  - [ ] 17.11 Implement `POST /api/requests/{id}/close` (`{status, finalNote, supportInstructions?}`): require a final note (`FINAL_NOTE_REQUIRED` when missing), optionally save updated `support_instructions`, record the final note as an external `request_note`, apply the closure transition through the R9 state machine, and audit closure, note, and instruction changes.
    - _Requirements: R25.1, R25.3, R25.4, R25.5, R25.6_
  - [ ]* 17.12 Backend tests for the closure flow: missing-note rejection, external-note recording, in-place support-instruction save, R9-valid closure transition, and audit coverage.
    - _Requirements: R25_
  - [ ] 17.13 Frontend New workflow — Unknown/Unlisted path: show the option in Step 1 (hidden for closed teams), the warning + "Acknowledge" gate, Step 2 single mandatory "Details" box plus optional Jira field, gate "Next" on Details, and submit `detailsText`.
    - _Requirements: R23.1, R23.2, R23.3, R23.4, R23.5, R23.6, R23.7_
  - [ ] 17.14 Frontend Support detail — Change Type flow: "Change Type" button, type-select pop-up with "Next", side-by-side view driven by `/change-type/preview`, completing the new form under the new type's rules, and "Switch" calling `/change-type`.
    - _Requirements: R24.1, R24.2, R24.3, R24.4, R24.5, R24.6_
  - [ ] 17.15 Frontend Support detail — Closure prompt + Support Instructions editor: closure-status prompt for the mandatory final note, "Support Instructions" inline editor that saves in place and returns, and "Close" calling `/close`.
    - _Requirements: R25.1, R25.2, R25.3, R25.4, R25.5_
  - [ ]* 17.16 Frontend tests for the three flows: Unknown/Unlisted acknowledgement/Details gating, Change Type side-by-side auto-population and Switch, and closure prompt final-note gating with the Support Instructions editor.
    - _Requirements: R23, R24, R25_
