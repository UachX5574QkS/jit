# Design

## Overview

The Helpdesk tool is a browser-based single-page application built with Angular (latest) and styled per the `ui-foundations` steering specification. It is backed by a PostgreSQL database (`helpdesk` database, `helpdesk` user) reached through a thin backend API. During development the whole stack runs on a laptop; the eventual target deploys the built static files via Oracle ORDS with authentication delegated to IDCS.

This design deliberately isolates two things behind abstractions so the future migration is cheap:

1. **Identity** — a single `CurrentUser` resolution point, so the development username/password login can be swapped for IDCS without touching feature code.
2. **Data access** — feature code talks to typed Angular services over a documented REST contract, never to the database directly, so the serving/runtime layer can change.

> **Note on the existing `frontend/` folder:** that directory contains the unrelated JIT Break Glass React SPA. The Helpdesk application is a new, standalone Angular project (proposed location `helpdesk/`), not a modification of the React app. The two do not share code.

### Requirements coverage

This design addresses all 25 requirements. Traceability is called out inline as _(Rn)_ references against the relevant component or table.

---

## Architecture

### High-level topology

```
Browser (Angular SPA)
   │  HTTPS/JSON  (typed Angular HttpClient services)
   ▼
Backend API  (dev: local runtime; future: ORDS)
   │  SQL (parameterised)
   ▼
PostgreSQL  (helpdesk)
   │
Ollama service (localhost) ← called by backend for the Step 3 summary
```

- **Frontend**: Angular SPA. Feature modules per menu area (New, Requests, Support, Statistics, Administer). Shared UI library implements the `ui-foundations` design tokens and components (sidebar, header, cards, forms, charts).
- **Backend API**: a thin HTTP/JSON layer that owns authentication, authorisation, validation, the status state machine, timer logic, audit writes, statistics aggregation, and the Ollama call. In development this is a small local server; the contract is defined so it can later be reimplemented as ORDS handlers. The specific dev runtime is not prescribed _(R22.3)_.
- **Database**: PostgreSQL, all timestamps `timestamptz` _(R18.1)_.
- **Ollama**: called server-side for the review summary, with a graceful fallback _(R2.11–2.12)_.

### Cross-cutting decisions

| Concern | Decision | Requirement |
|---|---|---|
| Identity resolution | Backend resolves the request principal to a single `CurrentUser` (id, display name, roles, team memberships, timezone). Dev = session from username/password login; future = IDCS token. Feature code only ever reads `CurrentUser`. | R1.3, R1.7, R22.4 |
| AuthZ | Role/permission derived from the superset of the user's memberships (user, support member of teams, team leader of teams, administrator group). Enforced server-side on every endpoint; frontend hides/reveals menus for UX only. | R1.8, roles-additive |
| Passwords | Hashed with a slow one-way KDF (bcrypt/argon2). Never returned or logged. Dev seed = "password1" hashed. | R1.5–1.6, R21.6 |
| Dates | Stored `timestamptz`; API returns ISO-8601 UTC; frontend renders in browser-local time; month buckets computed in the viewer's timezone. | R18 |
| Audit | Column-level audit rows written in the same transaction as any mutation. | R17 |
| Validation | Enforced server-side (source of truth) and mirrored client-side for UX. | R3 |
| Status transitions | Central server-side state machine; illegal transitions rejected. | R9 |

---

## Data Model

All tables use surrogate `bigint`/`uuid` primary keys, `created_at`/`updated_at timestamptz`, and are written through the API only.

### Identity & org

**`app_user`** _(R1, R19)_
- `id` PK
- `username` (8 digits, unique)
- `first_name`, `surname`
- `email`
- `manager_id` → `app_user.id` (nullable)
- `password_hash`
- `timezone` (nullable; falls back to browser)

**`area_manager`** _(R19.2–19.3)_ — separate lookup, not on `app_user`
- `user_id` → `app_user.id` (unique)

**`admin_group`** _(R1.8, R13.1)_
- `user_id` → `app_user.id` (unique)

### Teams & membership

**`team`** _(R13, R20)_
- `id` PK, `title`, `description`
- `team_leader_id` → `app_user.id`
- `is_closed` boolean (default false)

**`team_member`** _(R6, R15, R20.3)_
- `team_id` → `team.id`
- `user_id` → `app_user.id`
- unique(`team_id`,`user_id`)

### Data points & tasks (versioned)

**`data_point`** _(R14)_
- `id` PK, `name`, `data_type` (enum: TEXT, EMAIL, DATE, NUMERIC, DATETIME, TIME, BOOLEAN, DROPDOWN, REGEXP)
- `description`, `default_help_text`
- `regexp_pattern` (for REGEXP), `default_options` (for DROPDOWN, JSON array)
- `is_retired` boolean

**`task`** _(R16.6, R23)_
- `id` PK, `team_id` → `team.id`
- `name`
- `is_retired` boolean
- `is_unknown_unlisted` boolean (default false) _(R23)_ — marks the system-provided "Unknown/Unlisted" task. See decision 5: Unknown/Unlisted is modelled as a **per-team system task** (one non-retirable `task` row per team, flagged here) rather than a request-level flag, so it flows through the existing `task_version`/`request.task_version_id` machinery unchanged. Its single `task_version` carries no `task_field` rows; the free-text Details is captured separately (see `request.details_text`).
- `current_version_id` → `task_version.id`

**`task_version`** _(R16.4–16.5)_
- `id` PK, `task_id` → `task.id`
- `version_no`
- `support_notes` — the "Task support notes" surfaced read-only to support members via the "Help" button _(R16.7)_.
- `support_instructions` _(R25)_ — task-level editable handling guidance, held as a **distinct** column from `support_notes` (see decision 4 below). Editing it during the closure flow does **not** create a new `task_version`; the value is updated in place on the current version so existing and future requests of that task read the same guidance.
- `created_at`

**`task_field`** _(R16.2–16.3)_ — belongs to a `task_version` (immutable once versioned)
- `id` PK, `task_version_id` → `task_version.id`
- `data_point_id` → `data_point.id`
- `field_order`
- `is_mandatory`
- `help_text_override` (nullable), `description_override` (nullable)
- `options_override` (nullable JSON, DROPDOWN only)

> Task edits create a new `task_version` with a fresh set of `task_field` rows. Existing requests reference the `task_version` they were raised against, preserving their layout _(R16.4)_.

### Requests

**`request`** _(R2.14, R4, R9)_
- `id` PK
- `task_reference` (unique, human-facing)
- `task_version_id` → `task_version.id` — for an Unknown/Unlisted request this points at the team's Unknown/Unlisted `task_version`; a **type change** _(R24)_ swaps this to the new type's `current_version_id`, pinning that version, and replaces the `request_field_value` rows accordingly (no new request row) _(R24.6)_.
- `details_text` (nullable) _(R23.4)_ — the mandatory free-text "Details" captured on Step 2 for Unknown/Unlisted requests; null for typed requests.
- `title`
- `raised_by_id` → `app_user.id`
- `team_id` → `team.id`
- `assigned_member_id` → `app_user.id` (nullable) _(R6.6, R7.2)_
- `status` (enum, see state machine)
- `jira_number` (nullable)
- `estimated_start_date` (nullable) _(R4.5, entered by owner)_
- `actual_start_date` (nullable, may be future)
- `created_at`, `updated_at`

**`request_field_value`** _(R2, R3, R5.4)_
- `request_id` → `request.id`
- `task_field_id` → `task_field.id`
- `value` (text; typed on read/write per data point)

**`request_note`** _(R5.3, R7.3–7.4, R24.7, R25.4)_
- `id` PK, `request_id`
- `author_id`
- `is_internal` boolean
- `is_system_generated` boolean (default false) _(R24.7)_ — set for the auto-generated change-type note documenting before/after fields and values; such notes are external (`is_internal=false`) and customer-visible.
- `body`, `created_at`
- The **change-type note** _(R24.7)_ and the **final closure note** _(R25.4)_ are both stored here as external notes (`is_internal=false`); the closure note is authored by the closing support member, the change-type note is system-generated.

### Time tracking

**`time_slice`** _(R8)_
- `id` PK, `request_id`
- `member_id` → `app_user.id`
- `started_at`, `ended_at`
- `duration_minutes` (>= 1 when edited) _(R8.5)_

**`active_timer`** _(R4.6, R8.2, R8.8)_ — at most one open timer per (request, member)
- `id` PK, `request_id`, `member_id`, `started_at`
- unique open-timer index so concurrency prompts can be resolved

### Audit & read-state

**`audit_entry`** _(R17)_ — column-level
- `id` PK, `entity_type`, `entity_id`
- `field_name`, `old_value`, `new_value`
- `changed_by_id`, `changed_at`

**`request_last_seen`** _(R4.8, R5.2, R7.5–7.6)_ — drives the "Updated" indicator per user
- `request_id`, `user_id`, `last_seen_at`
- The "Updated" flag = request has a non-internal change after this user's `last_seen_at`.

### Status enum & state machine _(R9)_

States: `NEW, TRIAGE, ACCEPTED, ASSIGNED, ACTIVE, PAUSED, BLOCKED, REJECTED, CANCELLED, COMPLETE`.
Stop states: `REJECTED, CANCELLED, COMPLETE`.

Allowed transitions (enforced centrally):

```
NEW      → TRIAGE
TRIAGE   → ACCEPTED | REJECTED
ACCEPTED → ASSIGNED
ASSIGNED → ACTIVE | PAUSED | BLOCKED
PAUSED   → ACTIVE
BLOCKED  → ACTIVE
ACTIVE   → COMPLETE | PAUSED | BLOCKED
(any non-stop state) → CANCELLED
CANCELLED → NEW   (only via raiser "Reopen", only if raiser cancelled it)
```

`COMPLETE` reachable only from `ACTIVE` _(R9.5)_. Raiser Cancel/Reopen is a constrained path distinct from support status changes _(R5.5–5.7)_.

---

## API Design

Base path `/api`. All endpoints require an authenticated principal except `POST /api/auth/login`. Authorisation is enforced per endpoint from the resolved roles. Responses are JSON; dates ISO-8601 UTC.

### Auth & identity _(R1)_
- `POST /api/auth/login` — `{username, password}` → session; validates against `password_hash`.
- `POST /api/auth/logout`
- `GET  /api/auth/me` — resolved `CurrentUser` (id, name, roles, teams led, teams member of, isAdmin, timezone).
- `GET  /api/auth/users` — dev-only: list for the login drop-down _(R1.2)_.

### Requests (user side) _(R2, R4, R5)_
- `GET  /api/requests?scope=mine|team&hideComplete=&q=` — list for Requests screen, hierarchy-scoped _(R4.1–4.4, R19)_.
- `POST /api/requests` — submit from workflow; assigns reference, status NEW, pins task version _(R2.14)_.
- `GET  /api/requests/{id}` — detail incl. audit (internal notes excluded for non-support viewers) _(R5.1)_; records `last_seen` _(R5.2)_.
- `PATCH /api/requests/{id}/user-fields` — raiser updates Jira + user fields, mandatory not blankable _(R5.4)_.
- `POST /api/requests/{id}/notes` — add note (`is_internal=false` for raiser) _(R5.3)_.
- `POST /api/requests/{id}/cancel` — raiser only, non-stop → CANCELLED _(R5.5)_.
- `POST /api/requests/{id}/reopen` — raiser-who-cancelled only, CANCELLED → NEW _(R5.6)_.
- `POST /api/requests/{id}/clone` — returns pre-populated draft for workflow Step 2 _(R5.8)_.
- `GET  /api/tasks/{taskId}/estimated-effort` — type-level average _(R4.7)_.

### Workflow support _(R2, R3)_
- `GET  /api/teams?open=true` — teams for Step 1 _(R2.3)_.
- `GET  /api/teams/{id}/tasks?active=true` — non-retired tasks _(R2.3)_.
- `GET  /api/tasks/{id}/current-version` — fields, types, help, dropdown options _(R2.5–2.8, R3)_.
- `GET  /api/teams/{id}/tasks?active=true` returns the team's non-retired tasks **plus** the team's non-retirable "Unknown/Unlisted" system task (flagged `isUnknownUnlisted:true`), suppressed for closed teams _(R23.1–23.2)_.
- `POST /api/requests` accepts an Unknown/Unlisted submission carrying `detailsText` (mandatory) and optional `jiraNumber` instead of typed field values; the request is persisted with `details_text` set and its type marked Unknown/Unlisted _(R23.4, R23.6–23.7)_.
- `POST /api/review/summary` — `{taskVersionId, values}` → Ollama summary; on failure returns `{available:false}` and the echoed values _(R2.11–2.12)_. For Unknown/Unlisted requests the `detailsText` is passed as the summary input.

### Support side _(R6, R7, R8)_
- `GET  /api/support/requests?team=&scope=mine|team&hideComplete=&showUnassigned=&q=` _(R6)_.
- `PATCH /api/requests/{id}` — support update of any field + status (state-machine checked) + assignment _(R7.1–7.2, R9)_.
- `POST /api/requests/{id}/notes` — internal or external _(R7.3–7.4)_.
- `POST /api/requests/{id}/timer/start` — start timer; body may resolve concurrent-timer prompt (`stopOthers:true|false`) _(R8.2, R8.8)_.
- `POST /api/requests/{id}/timer/stop` — `{durationMinutes?}` (>=1 if edited) → records `time_slice` _(R8.4–8.6)_.
- `GET  /api/requests/{id}/timers/mine` — current running timer(s) for prompt logic _(R8.8)_.
- `GET  /api/requests/{id}/change-type/preview?newTaskId=` — returns the side-by-side field mapping: the current request's fields/values (left) and the new type's current-version fields (right), with matching fields auto-populated and unmatched fields blank _(R24.3–24.4)_. Field matching is by underlying `data_point_id`.
- `POST /api/requests/{id}/change-type` — `{newTaskId, values}` → validates the new type's mandatory/type rules, swaps `task_version_id` to the new type's current version, replaces `request_field_value` rows, writes the auto-generated customer-visible before/after note, and audits the type change and every field-value change _(R24.5–24.8)_.
- `POST /api/requests/{id}/close` — `{status: COMPLETE|REJECTED|CANCELLED, finalNote, supportInstructions?}` → optionally saves updated `task_version.support_instructions`, records `finalNote` as an external note, applies the closure transition through the state machine, and audits closure, note, and support-instruction changes _(R25.1, R25.3–25.6)_.
- `PATCH /api/task-versions/{id}/support-instructions` — `{supportInstructions}` in-place update of the current version's editable instructions, callable from the closure prompt's "Support Instructions" editor; audited _(R25.2–25.3, R25.6)_.

### Statistics _(R10, R11, R12, R18.3)_
- `GET /api/stats/user` — charts + summary table for current user _(R10)_.
- `GET /api/stats/team` — hierarchy-scoped _(R11)_.
- `GET /api/stats/support?team=|all` — team-level tables + chart _(R12)_.
All accept the client timezone (or use `CurrentUser.timezone`) for month bucketing.

### Administration _(R13, R14, R15, R16)_
- `POST/GET/PATCH /api/admin/teams` — create/list/update-leader/close; close guarded by open requests _(R13, R20.2)_.
- `POST/GET/PATCH /api/admin/data-points` — CRUD + retire _(R14)_.
- `GET/PATCH /api/team-leader/teams/{id}` — membership + details (leader-only); member-removal guarded _(R15)_.
- `POST/PATCH /api/team-leader/tasks` — create/new-version tasks; retire; leader-only _(R16)_.

### Error model
Uniform `{error: {code, message, details?}}`. Notable codes: `INVALID_TRANSITION` _(R9.7)_, `MANDATORY_FIELD` _(R3.6, R5.4, R23.6)_, `VALIDATION_FAILED` _(R3, R24.5)_, `FORBIDDEN` (role/authz), `CONFLICT_OPEN_REQUESTS` (R20.2–20.3), `TIMER_MIN_DURATION` _(R8.5)_, `ACKNOWLEDGE_REQUIRED` _(R23.3)_ (Unknown/Unlisted warning not acknowledged), `FINAL_NOTE_REQUIRED` _(R25.1)_ (closure attempted without a final note).

---

## Frontend Design

### Structure

```
helpdesk/                      (new Angular project — not the React frontend/)
  src/app/
    core/            auth, current-user, http interceptors, guards, timezone
    shared/          ui-foundations components, chart wrappers, date pipe
    features/
      new/           3-step request workflow
      requests/      list + detail (user actions)
      support/       queue + detail (support actions, timer)
      statistics/    user / team / support dashboards
      administer/    admin tiles + team-leader tiles
```

- **`core/CurrentUserService`** — loads `/auth/me`, exposes roles/teams; the single identity source _(R1.7)_.
- **Route guards** — gate feature routes by role; menu rendered from the role superset _(R1.8)_. Server remains the enforcement point.
- **`shared/` UI** — implements the `ui-foundations` tokens: 108px icon sidebar, top header with search + dark-mode toggle, content cards, purple form styling, workflow step row, bar/pie charts, dark mode persisted to `localStorage`, responsive breakpoints, reduced-motion support.
- **Timezone** — a shared date pipe renders all timestamps in browser-local time _(R18.2)_; charts request month buckets in the viewer's timezone _(R18.3)_.

### Key flows

- **New workflow** — stepper enforces sequence and mandatory/type validation before advancing _(R2.9–2.10, R3)_; Step 3 calls `/review/summary` and falls back to entered values on failure _(R2.11–2.12)_.
- **New workflow — Unknown/Unlisted** — Step 1's task list always includes an "Unknown/Unlisted" option (hidden only for closed teams); selecting it shows the warning "Warning: Only use if a Task does not match requirements. If a task type exists already the request may be rejected" and blocks progression until the user clicks "Acknowledge" _(R23.1–23.3)_. Step 2 then renders a single mandatory free-text "Details" box plus the always-present optional Jira field, and gates "Next" on Details being non-empty _(R23.4–23.6)_. Submit posts `detailsText` and behaves like any other submission _(R23.7)_.
- **Requests detail** — opening clears the Updated flag _(R5.2)_; Cancel/Reopen/Clone buttons shown per the raiser rules _(R5.5–5.8)_; audit trail hides internal notes _(R5.1)_.
- **Support detail** — full editing incl. status via the state machine _(R7, R9)_; internal vs external notes _(R7.4–7.5)_; timer button appears only in ACTIVE, "Working on It"/"Back to Queue" with the duration pop-up and concurrent-timer prompt _(R8)_.
- **Support detail — Change Type** — a "Change Type" button opens a pop-up to pick a new type then "Next" _(R24.1–24.2)_; the side-by-side view (`/change-type/preview`) shows current fields/values on the left and the new type's fields on the right, auto-populating matches and leaving others blank _(R24.3–24.4)_; completing the new form (honouring the new type's mandatory/type rules) and clicking "Switch" calls `/change-type`, which re-saves the request under the new type, pins the new version, generates the customer-visible before/after note, and audits the changes _(R24.5–24.8)_.
- **Support detail — Closure prompt + Support Instructions** — selecting a closure status (Complete/Rejected/Cancelled) opens a prompt for a mandatory final customer note before "Close" _(R25.1)_; a "Support Instructions" button opens the task's instructions in an inline editor that saves in place and returns to the prompt _(R25.2–25.3)_; "Close" posts to `/close`, recording the final note as an external note and applying the closure transition via the state machine, with all changes audited _(R25.4–25.6)_.

---

## Ollama Integration _(R2.11–2.12)_

- Called **server-side** from `POST /api/review/summary` (keeps the model endpoint off the browser and eases the future ORDS move).
- Short timeout; any error/timeout → `{available:false}` so the frontend shows entered values and submission proceeds.
- No request data is persisted by the summary call; it is display-only.

---

## Testing Strategy

- **State machine** — unit tests asserting every allowed/blocked transition, `COMPLETE`-only-from-`ACTIVE`, and cancel-from-any-non-stop _(R9)_.
- **Validation** — per data type, incl. regexp/email/numeric and mandatory rules _(R3)_.
- **Hierarchy** — resolution tests incl. area-manager cutoff and cycle termination _(R19)_.
- **Timers** — duration calc, >1-min edit rule, multiple slices per request/member, concurrent-timer prompt _(R8)_.
- **AuthZ** — endpoint access per role; Ollama-down fallback path _(R1.8, R2.12)_.
- **Reference-data guards** — close-team / remove-member / retire blocked by open requests _(R20)_.
- **Statistics** — aggregation correctness and timezone month bucketing _(R10–R12, R18.3)_.
- **Unknown/Unlisted** — the option always appears for open teams and is hidden for closed teams; acknowledgement gate blocks progression; Step 2 requires Details; submission persists `details_text`, marks the Unknown/Unlisted type, and audits creation _(R23)_.
- **Change Type** — preview mapping auto-populates matching fields (by data point) and blanks the rest; "Switch" enforces the new type's mandatory/type rules, swaps and pins the new task version, replaces field values, writes the auto-generated before/after customer note, and audits the type and field-value changes _(R24)_.
- **Closure flow** — closure status prompts for a mandatory final note; missing note is rejected (`FINAL_NOTE_REQUIRED`); Support Instructions editor persists in place; "Close" records the external note, applies only the R9-valid transition, and audits closure, note, and instruction changes _(R25)_.

---

## Confirmed design decisions

1. **Backend dev runtime** — the development backend is a lightweight Node/Express HTTP/JSON API. Its handlers are structured to map cleanly onto future ORDS PL/SQL so the migration is a reimplementation of the same contract, not a redesign.
2. **Session mechanism (dev)** — the development login establishes an HTTP-only session cookie. In the future ORDS/IDCS deployment this is replaced by IDCS token-based authentication, resolved through the same `CurrentUser` abstraction.
3. **Timer on request close** — if a request leaves `ACTIVE` while a timer is running, the timer is auto-stopped and the slice is recorded up to that moment (never discarded).
4. **Support instructions vs support notes** — the initial design distinguishes read-only "Task support notes" (surfaced via the "Help" button, _R16.7_) from editable "Support Instructions" edited during closure (_R25_). These are modelled as **two distinct columns** on `task_version` (`support_notes` and `support_instructions`) rather than reusing one field, so the closure-time editable guidance can evolve without disturbing the established Help-button notes. Editing `support_instructions` updates the current `task_version` in place and does not create a new version.
5. **Unknown/Unlisted modelling** — Unknown/Unlisted is modelled as a **per-team system task** (a non-retirable `task` row flagged `is_unknown_unlisted`, with a single `task_version` and no `task_field` rows) rather than a flag on `request`. This lets it reuse the existing `request.task_version_id` pinning, task-list, and closed-team-exclusion machinery unchanged; the free-text Details is stored in the new `request.details_text` column.
6. **Type change is an in-place re-save** — changing a request's type swaps `request.task_version_id` to the new type's current version and replaces the request's field values on the same request row (preserving `task_reference`, history, and audit continuity) rather than creating a new request.
