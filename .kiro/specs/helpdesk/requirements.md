# Requirements

## Introduction

The Helpdesk tool lets users raise requests for work against support teams and track those requests from creation through to a closing state. Support team members triage, assign, and work requests, recording time spent, while users, managers, team leaders, and administrators view progress and statistics scoped to their role.

The application is a browser-based JavaScript/Angular frontend backed by a PostgreSQL data store, following the `ui-foundations` steering specification. During development it runs locally on a laptop; the eventual target is deployment into an Oracle environment with static files served via ORDS and authentication delegated to IDCS. The development username/password login is a stand-in that IDCS will later replace, so the application treats the current user as a single resolved identity that can be sourced from either mechanism.

### Glossary

- **User** — a person who raises requests. Identified by an 8-digit username, a display name of the form "firstname surname", an email address, and a manager username.
- **Support Member** — a person linked to one or more support teams who works requests. May also be a user.
- **Team Leader** — the person recorded as leader of a team; manages team membership and the team's tasks.
- **Administrator** — a person in the administrator group; manages teams and data points.
- **Manager** — a person referenced as another user's manager, forming the hierarchy used by "My Team" filters and Team Statistics.
- **Data Point** — a reusable field definition (name, data type, description, default help text) maintained by administrators.
- **Task** — a request type owned by a team, composed of task fields mapped to data points; versioned on change.
- **Request** — a unit of work raised by a user against a team's task, progressing through the status lifecycle.
- **Time Slice** — a recorded period a support member spent working a request while it was Active.
- **Closed / Stop states** — Complete, Rejected, and Cancelled.

### Roles are additive

A single person may simultaneously be a user, a support member, a team leader, and/or an administrator. The superset of their roles determines which menu items and actions are available to them.

---

## Requirement 1: Authentication and identity

**User Story:** As a person using the tool, I want to log in and have the tool recognise who I am and what I can do, so that I see the right menus and data.

#### Acceptance Criteria

1. WHEN the application loads and no user is authenticated THEN the system SHALL present a login screen prompting for a username and a password.
2. WHERE the environment is development THE system SHALL present the username field as a drop-down listing each created person in the form "`<8-digit-username>` `<firstname>` (`<role>`) `<surname>`" (for example "11111111 Jason (Administrator) Hughes").
3. WHEN a user submits valid credentials THEN the system SHALL establish an authenticated session resolved to a single current-user identity.
4. WHEN a user submits invalid credentials THEN the system SHALL reject the login and SHALL NOT establish a session.
5. THE system SHALL store user passwords hashed (one-way) and SHALL NOT store or be able to reveal the plaintext password.
6. WHERE the environment is development ALL user accounts SHALL have the password "password1" (stored hashed).
7. THE system SHALL resolve the current user's identity through a single abstraction so that the authentication source can be switched from the development login to IDCS without changing the rest of the application.
8. WHEN a user is authenticated THEN the system SHALL determine the visible menu items and permitted actions from the superset of that user's roles (user, support member, team leader, administrator).

---

## Requirement 2: Raising a request (the "New" workflow)

**User Story:** As a user, I want to raise a request against a team and task through a guided workflow, so that I provide the right information before submitting.

#### Acceptance Criteria

1. THE system SHALL make the "New" menu option available to every authenticated user.
2. WHEN a user opens "New" THEN the system SHALL present a three-step workflow: Team and Task, Request Details, Review.
3. WHEN on Step 1 THEN the system SHALL present a drop-down of teams that are not closed, and WHEN a team is selected THEN the system SHALL present that team's non-retired tasks for selection.
4. WHEN on Step 1 THEN the system SHALL offer "Cancel" (exit the workflow) and "Next" (proceed only when a team and task are selected).
5. WHEN a user advances to Step 2 THEN the system SHALL present all fields defined by the selected task version, honouring each field's data type and mandatory flag.
6. WHERE a field has a description or help text THE system SHALL display a "?" affordance next to the field that reveals the help text when clicked.
7. WHERE a field is a Date or Date+Time type THE system SHALL capture the value using an appropriate picker rather than free text entry.
8. THE system SHALL always present an additional optional "Jira" field on Step 2.
9. WHEN on Step 2 THEN the system SHALL offer "Cancel", "Previous" (return to Step 1), and "Next".
10. THE system SHALL prevent advancing from Step 2 to Step 3 unless all mandatory fields are completed and all entered values satisfy their data type and validation (including regexp fields matching their pattern).
11. WHEN a user advances to Step 3 THEN the system SHALL present a summary of the request generated by the locally running Ollama service.
12. IF the Ollama service is unavailable THEN the system SHALL display the values entered by the user instead of a generated summary, and SHALL still allow submission.
13. WHEN on Step 3 THEN the system SHALL offer "Cancel", "Previous" (return to Step 2), and "Submit".
14. WHEN a user clicks "Submit" THEN the system SHALL create the request, assign it a unique task reference, set its status to "New", record the created and last-updated timestamps, and persist the task version in use at that time.

---

## Requirement 3: Data types and field validation

**User Story:** As a user completing a request, I want fields to enforce their type and rules, so that captured data is valid.

#### Acceptance Criteria

1. THE system SHALL support the data point types: Text, Email Address, Date, Numeric, Date+Time, Time, Boolean, Dropdown, and Regexp.
2. WHEN a field is Email Address THEN the system SHALL validate the value as a well-formed email address.
3. WHEN a field is Numeric THEN the system SHALL accept only numeric input.
4. WHEN a field is Regexp THEN the system SHALL validate the value against the regular expression defined for that field and reject non-matching input.
5. WHEN a field is Dropdown THEN the system SHALL present the option list defined for that task field (the task-level override list where provided, otherwise the data point's default list).
6. WHEN a mandatory field is empty THEN the system SHALL prevent progression and indicate the field is required.

---

## Requirement 4: Viewing requests (the "Requests" screen)

**User Story:** As a user or manager, I want to view and search the requests I raised or that fall under my management chain, so that I can track their progress.

#### Acceptance Criteria

1. THE system SHALL make the "Requests" screen available to a user only when they have raised at least one request or requests exist within their management hierarchy.
2. THE system SHALL provide a search box that filters on any field within the scope of the active toggle.
3. THE system SHALL provide a "My Requests / My Team" toggle defaulting to "My Requests"; "My Requests" SHALL show requests raised by the current user, and "My Team" SHALL show requests raised by anyone within the current user's downward management hierarchy.
4. THE system SHALL provide a "Hide Complete" checkbox defaulting to checked that, when checked, excludes requests in Complete, Rejected, or Cancelled status.
5. THE system SHALL display each matching request as a row showing: Task Number, Jira Number, Title, Date Raised, Status, Support Team, Assigned Team Member, Last Updated, Estimated Start Date, Actual Start Date, Estimated Effort, and an "Updated" indicator.
6. WHERE a request has an open timer against it and is not closed THE system SHALL append " (Working On)" to the displayed status.
7. THE system SHALL calculate Estimated Effort for a task type as the sum of all recorded time slices across that task type's Complete requests divided by the number of Complete requests of that task type.
8. WHERE a request has changed since the current user last opened it THE system SHALL show the "Updated" indicator for that user.
9. THE system SHALL display all dates in the local date/time of the viewing user's browser.

---

## Requirement 5: Request detail and user actions

**User Story:** As the raiser of a request, I want to view its full detail, add notes, update my fields, and cancel or reopen it, so that I can manage my own request.

#### Acceptance Criteria

1. WHEN a user opens a request THEN the system SHALL display all request information and an audit trail of all changes, excluding support team internal notes.
2. WHEN a user opens a request THEN the system SHALL clear that user's "Updated" indicator for that request.
3. THE system SHALL allow the raiser to add new notes that are visible to support members.
4. THE system SHALL allow the raiser to update the Jira number and any user-entered fields, WHILE preventing mandatory fields from being blanked out.
5. WHERE a request is not in a closed state THE system SHALL present a "Cancel" button to the person who raised the request that sets the status to Cancelled.
6. WHERE a request is in Cancelled status AND the current user is the person who cancelled it THE system SHALL present a "Reopen" button that returns the status to New.
7. THE system SHALL NOT allow a user to change the status in any other circumstance or to any other value.
8. THE system SHALL present a "Clone" button when viewing any request that creates a new request opened at Step 2 of the workflow, pre-populated with the original request's values and a status of New.

---

## Requirement 6: Support queue (the "Support" screen)

**User Story:** As a support member, I want to view and filter my team's request queue, so that I can find work to progress.

#### Acceptance Criteria

1. THE system SHALL make the "Support" screen available to support members.
2. THE system SHALL provide a search box that filters on any field within the scope of the active toggle and team drop-down.
3. THE system SHALL provide a "Team" drop-down listing the teams the current user belongs to, plus an "All" option meaning all teams the user is in.
4. THE system SHALL provide a "My Queue / Team Queue" toggle defaulting to "My Queue"; "My Queue" SHALL show requests assigned to the current user, and "Team Queue" SHALL show requests for the selected team (or all the user's teams when "All" is selected).
5. THE system SHALL provide a "Hide Complete" checkbox defaulting to checked that, when checked, excludes requests in Complete, Cancelled, or Rejected status.
6. THE system SHALL provide a "Show Unassigned" checkbox defaulting to checked that includes or excludes requests with no assigned team member.
7. THE system SHALL present the same request columns as the "Requests" screen.

---

## Requirement 7: Support member request handling

**User Story:** As a support member, I want to update a request's status, assignment, notes, and fields, so that I can progress the work and keep the raiser informed.

#### Acceptance Criteria

1. WHEN a support member opens a request THEN the system SHALL allow updating any field, including status (subject to the status lifecycle rules), and the assigned owner.
2. THE system SHALL allow any member of a team to assign a request to any other member of that team.
3. THE system SHALL allow a support member to add notes that are visible to the raiser on the Requests screen.
4. THE system SHALL allow a support member to add internal notes that are visible only to support members via the Support screen and never to the raiser.
5. WHEN internal notes are updated THEN the system SHALL NOT trigger the "Updated" indicator on the user's Requests view, BUT SHALL reflect the update on the Support screen.
6. WHEN any change other than an internal-note update occurs THEN the system SHALL trigger the "Updated" indicator for the raiser.
7. THE system SHALL record every change to a request in the audit trail.

---

## Requirement 8: Time tracking

**User Story:** As a support member, I want to record time spent actively working a request, so that effort is captured for reporting.

#### Acceptance Criteria

1. WHERE a request's status is Active THE system SHALL present a "Working on It" button with a timer symbol; the button SHALL NOT be presented when the status is not Active.
2. WHEN a support member clicks "Working on It" THEN the system SHALL start a timer for that support member against that request without changing the request's status.
3. WHEN a timer is running THEN the system SHALL change the button to "Back to Queue" with a timer symbol.
4. WHEN a support member clicks "Back to Queue" THEN the system SHALL present a pop-up showing the elapsed time (in days, hours, and minutes) between clicking "Working on It" and "Back to Queue".
5. THE system SHALL allow the support member to keep the presented time or edit it before confirming, and WHEN the time is edited THEN the edited value MUST be greater than 1 minute.
6. WHEN the support member clicks "Confirm" THEN the system SHALL record the time slice, retaining the duration and the support member who recorded it.
7. THE system SHALL allow multiple support members to record time slices against the same request, and SHALL allow a single support member to record more than one time slice against the same request.
8. WHEN a support member clicks "Working on It" WHILE they already have a timer running on another request THEN the system SHALL prompt them to either stop the existing timer(s) ("Back to Queue") or leave them running.
9. THE system SHALL retain all time slices for use in effort and duration reporting.

---

## Requirement 9: Status lifecycle

**User Story:** As the tool, I want to enforce valid status transitions, so that requests follow a consistent lifecycle.

#### Acceptance Criteria

1. THE system SHALL support the statuses: New, Triage, Accepted, Assigned, Active, Paused, Blocked, Rejected, Cancelled, Complete.
2. THE system SHALL set a newly submitted request to New.
3. THE system SHALL treat Rejected, Cancelled, and Complete as stop (closed) states.
4. THE system SHALL permit the following transitions: New → Triage; Triage → Accepted or Rejected; Accepted → Assigned; Assigned → Active, Paused, or Blocked; Paused → Active; Blocked → Active; Active → Complete, Paused, or Blocked.
5. THE system SHALL allow Complete only from Active.
6. THE system SHALL allow a transition to Cancelled from any non-stop state.
7. THE system SHALL prevent transitions that are not permitted by these rules.

---

## Requirement 10: User Statistics

**User Story:** As a user, I want statistics about the requests I have raised, so that I can understand my request patterns and effort.

#### Acceptance Criteria

1. THE system SHALL present a stacked bar chart of the number of the user's requests by status, broken down by month based on the user's timezone.
2. THE system SHALL present a pie chart of the number of requests the user has raised by task type.
3. THE system SHALL present a pie chart, positioned to the right of the type-count pie chart, of the total recorded time across the user's requests broken down by task type (as a proportion of the total).
4. THE system SHALL present a summary table by task type showing: number of requests raised, number of requests per status, average time from New to Triage, and average lifespan from Triage to a Complete status.
5. THE system SHALL exclude Rejected and Cancelled requests from the Triage-to-completion average.

---

## Requirement 11: Team Statistics

**User Story:** As a manager, I want statistics across my management chain, so that I can understand my team's request activity.

#### Acceptance Criteria

1. THE system SHALL present the same statistics as User Statistics, filtered to every person within the current user's downward management hierarchy (direct reports and, recursively, their reports).
2. THE system SHALL apply the same month/timezone basis and the same Rejected/Cancelled exclusion rules as User Statistics.

---

## Requirement 12: Support Statistics

**User Story:** As a support member, I want statistics at the support team level, so that I can understand team workload and durations.

#### Acceptance Criteria

1. THE system SHALL present, at the top, a list of the teams the current user is associated with plus an "All Teams" option covering every team the user is in simultaneously.
2. THE system SHALL present a stacked bar chart of the number of requests by status, broken down by month based on the user's timezone.
3. THE system SHALL present a table whose rows are tasks (or "Team - Task" when "All Teams" is selected) and whose columns are the names of the team members, with each cell showing the total number of requests assigned to that member regardless of status.
4. THE system SHALL present a second table with the same dimensions where each cell shows the average duration from Accepted to Complete for requests associated with that member, excluding Rejected and Cancelled requests.

---

## Requirement 13: Team administration (Tool Administrator)

**User Story:** As an administrator, I want to create and maintain teams, so that support work can be organised.

#### Acceptance Criteria

1. THE system SHALL present the "Administer" option and its Tool Administrator tiles only to users in the administrator group.
2. THE system SHALL allow an administrator to create a new team and assign it a team leader.
3. THE system SHALL display existing teams in a table where an administrator can change a team's leader/owner or close the team.
4. WHEN a team is closed THEN the system SHALL exclude it from team selection menus when raising new requests WHILE retaining its existing requests in the system.
5. THE system SHALL prevent closing a team that has any associated requests which are not closed.

---

## Requirement 14: Data point administration

**User Story:** As an administrator, I want to maintain the catalogue of data points, so that team leaders can build tasks from consistent field definitions.

#### Acceptance Criteria

1. THE system SHALL allow an administrator to view all existing data points.
2. THE system SHALL allow an administrator to create a data point with a name, description, data type, and default help text.
3. THE system SHALL allow an administrator to retire a data point.
4. WHEN a data point is retired THEN the system SHALL prevent its selection for any new task definition WHILE keeping it operational for any task definition currently using it.

---

## Requirement 15: Team management by team leaders

**User Story:** As a team leader, I want to manage my team's membership, so that the right people can work my team's requests.

#### Acceptance Criteria

1. THE system SHALL present the Team Leader tiles only to users who are recorded as the leader of at least one team.
2. THE system SHALL allow a team leader to update the details of a team they lead.
3. THE system SHALL allow a team leader to change the membership of a team they lead.
4. THE system SHALL prevent removing a support member from a team while that member has any non-closed requests associated with them under that team.

---

## Requirement 16: Task management by team leaders

**User Story:** As a team leader, I want to create and update tasks for my team with versioning, so that new requests use the current definition while existing requests keep their original layout.

#### Acceptance Criteria

1. THE system SHALL allow a team leader to create new tasks and update existing tasks only for teams they lead.
2. THE system SHALL allow a team leader to set, for a task: the field order, the fields involved (selected from non-retired data points), dropdown value overrides, and task support notes.
3. THE system SHALL allow a task field to override the data point's default description and help text, BUT SHALL NOT allow overriding its name or data type.
4. WHEN a team leader updates an existing task THEN the system SHALL create a new version of the task so that requests already raised against a prior version retain that version's layout.
5. WHEN a user raises a new request against a task THEN the system SHALL present the current (latest) task version.
6. THE system SHALL allow a task to be retired so that it cannot be selected for new requests WHILE remaining associated with requests already raised against it.
7. THE system SHALL present task support notes to support members via a "Help" button when working a request of that task type.

---

## Requirement 17: Auditing

**User Story:** As any stakeholder, I want a complete audit trail of changes, so that accountability is preserved.

#### Acceptance Criteria

1. WHEN any value changes THEN the system SHALL record an audit entry capturing who made the change, the field changed, the previous value, and the new value.
2. THE system SHALL store audit records at column (field) level.
3. THE system SHALL record and maintain the created timestamp and last-updated timestamp for every request.
4. THE system SHALL exclude support team internal notes from the audit trail shown to the raiser on the Requests screen, WHILE showing them to support members on the Support screen.

---

## Requirement 18: Dates and timezone handling

**User Story:** As a user in any location, I want dates shown in my local time, so that timestamps are meaningful to me.

#### Acceptance Criteria

1. THE system SHALL store all date/time values with their timezone.
2. THE system SHALL present all dates and times to a user in the local date/time of that user's browser.
3. THE system SHALL group statistics "by month" using the viewing user's timezone.

---

## Requirement 19: Manager hierarchy

**User Story:** As the tool, I want to resolve management hierarchies consistently, so that "My Team" filters and Team Statistics include the correct people.

#### Acceptance Criteria

1. THE system SHALL build a person's downward hierarchy starting from the people who record that person as their manager, then recursively including the people managed by each of those, until no further reports remain.
2. WHERE a person is marked as an area manager THE system SHALL start that person's hierarchy at themselves and SHALL NOT traverse upward to their own manager.
3. THE system SHALL store the area-manager designation in a separate lookup table rather than in the core user record.
4. THE system SHALL guard hierarchy traversal against cycles so that resolution always terminates.

---

## Requirement 20: Reference data lifecycle constraints

**User Story:** As the tool, I want to protect referential integrity when retiring or closing reference data, so that historical requests stay intact.

#### Acceptance Criteria

1. THE system SHALL retain all existing requests when a team is closed, a task is retired, or a data point is retired.
2. THE system SHALL prevent closing a team that has non-closed requests.
3. THE system SHALL prevent removing a support member from a team while they have non-closed requests under that team.
4. THE system SHALL keep retired data points and retired tasks operational for the requests and task versions already using them.

---

## Requirement 21: Development seed data

**User Story:** As a developer, I want representative seed data, so that I can exercise the full application locally.

#### Acceptance Criteria

1. THE system SHALL seed at least one administrator who can manage teams and data points.
2. THE system SHALL seed at least 5 teams, each with a team leader and at least 5 members (who may also be users), and at least 3 tasks per team.
3. THE system SHALL seed each team leader with 2 team members who are themselves managers of 2 users each.
4. THE system SHALL seed a selection of users who each have several requests raised across teams and task types.
5. THE system SHALL seed requests in a range of statuses that collectively exercise the defined status transition routes.
6. THE system SHALL seed all development accounts with the password "password1" stored hashed.

---

## Requirement 22: Architecture and runtime

**User Story:** As a developer and future deployer, I want the app to run locally now and migrate to Oracle later, so that development is unblocked without foreclosing the target platform.

#### Acceptance Criteria

1. THE system SHALL be a browser-based JavaScript/Angular application (latest Angular) that adheres to the `ui-foundations` steering specification.
2. THE system SHALL use PostgreSQL (the local `helpdesk` database, user `helpdesk`) as its backend data store.
3. WHERE the environment is development THE system SHALL run end-to-end on a local laptop; the specific local serving runtime is an implementation detail and is not prescribed.
4. THE system SHALL keep the frontend and its data-access and identity concerns loosely coupled so that a later migration to ORDS-served static files and IDCS authentication is not blocked by early implementation choices.

---

## Requirement 23: Unknown/Unlisted task in the "New" workflow

**User Story:** As a user who cannot find a matching task, I want a default "Unknown/Unlisted" option in the "New" workflow, so that I can still raise a request describing my need in free text.

#### Acceptance Criteria

1. WHEN a user selects a team on Step 1 THEN the system SHALL always present an "Unknown/Unlisted" option in that team's task list in addition to the team's non-retired tasks.
2. THE system SHALL never retire the "Unknown/Unlisted" option, WHILE still excluding it for teams that are closed.
3. WHEN a user selects the "Unknown/Unlisted" option THEN the system SHALL display a warning stating "Warning: Only use if a Task does not match requirements. If a task type exists already the request may be rejected" and SHALL require the user to click "Acknowledge" before proceeding.
4. WHERE the selected task is "Unknown/Unlisted" THE system SHALL present Step 2 as a single mandatory free-text "Details" field instead of typed task fields.
5. WHERE the selected task is "Unknown/Unlisted" THE system SHALL still present the always-present optional "Jira" field on Step 2.
6. THE system SHALL prevent advancing from Step 2 to Step 3 for an "Unknown/Unlisted" request unless the "Details" field is completed.
7. WHEN a user submits an "Unknown/Unlisted" request THEN the system SHALL create the request with a unique task reference, set its status to "New", record the created and last-updated timestamps, mark the request as the "Unknown/Unlisted" type, and record the change in the audit trail.

---

## Requirement 24: Changing a request's task type (Support)

**User Story:** As a support member, I want to change a request to a different task type, so that a mis-typed or unlisted request can be recorded under the correct type.

#### Acceptance Criteria

1. WHEN a support member opens a request THEN the system SHALL present a "Change Type" button on the request detail.
2. WHEN a support member clicks "Change Type" THEN the system SHALL present a pop-up to select a new task type and offer "Next".
3. WHEN a support member clicks "Next" after selecting a new type THEN the system SHALL present a side-by-side view showing the current request's fields and values on the left and the new type's fields on the right.
4. WHEN the side-by-side view is presented THEN the system SHALL auto-populate each new-type field that matches a current field, WHILE leaving fields with no match blank.
5. THE system SHALL require the completed new form to satisfy the new type's mandatory flags and data-type validation before the change is accepted.
6. WHEN a support member clicks "Switch" THEN the system SHALL re-save the request under the new task type and pin the new type's current task version to the request.
7. WHEN a request's type is changed THEN the system SHALL add an auto-generated customer-visible note documenting the before and after fields and values.
8. WHEN a request's type is changed THEN the system SHALL record the task-type change and every field-value change in the audit trail.

---

## Requirement 25: Closing a request with a final note and support instructions (Support)

**User Story:** As a support member, I want to add a final customer note and update the task's support instructions when I close a request, so that the customer is informed and future handling guidance is captured.

#### Acceptance Criteria

1. WHEN a support member selects a closure status of Complete, Rejected, or Cancelled THEN the system SHALL prompt the support member to enter a final customer note before offering "Close".
2. WHEN the closure prompt is shown THEN the system SHALL present a "Support Instructions" button that opens the task's support instructions in edit mode.
3. WHEN a support member edits the support instructions and clicks "Save" THEN the system SHALL persist the updated support instructions and return the support member to the closure prompt to click "Close".
4. WHEN a support member clicks "Close" THEN the system SHALL record the final note as an external customer-visible note.
5. WHEN a support member clicks "Close" THEN the system SHALL apply the closure status transition, honouring the status lifecycle rules of Requirement 9.
6. WHEN a request is closed through this flow THEN the system SHALL record the closure, the final note, and any support-instruction changes in the audit trail.
