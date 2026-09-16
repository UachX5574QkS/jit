# Helpdesk — Backlog

Deferred enhancements captured for later implementation. Not yet built; not in
scope of the current requirements/design/tasks. Listed newest first.

---

## B1. Restrict Estimated Effort to the Support screens

**Intent:** Give the support person a sense of how long a request will take,
without setting an expectation the team may not be able to meet in front of the
requester.

**Change:**
- Remove the **Estimated Effort** column from the user-facing **My Requests**
  screen (list) and from the requester's request-detail view.
- Keep Estimated Effort on the **Support** screens only (Support Queue list and
  Support detail / statistics).

**Notes / scope:**
- The value itself (type-level average from completed requests of the same task
  type) is unchanged — this is purely about *where it is shown*.
- Backend: the requests-list store may stop computing/returning
  `estimatedEffortMinutes` for the user list, or the frontend simply hides the
  column. Prefer not returning it to the requester so the figure never reaches
  the browser.
- Update tests: requests-list unit test + the `estimated-effort` E2E to assert
  the column is absent on the Requests screen and present on Support.

---

## B2. Teams chat link alongside Jira

**Intent:** Let a request carry a Microsoft Teams chat link (a conversation
thread) in addition to / instead of a Jira number.

**Change:**
- Alongside the existing **Jira** field (New workflow Step 2, request detail,
  support detail), add an optional **Teams chat link** field (paste a URL).
- Persist it on the request (new nullable column, e.g. `request.teams_chat_url`),
  expose it through the create/detail/update contracts, and validate it is a
  well-formed URL when provided.

**Notes / scope:**
- Editable by the raiser (user-fields update) and by support (support mutation),
  same as Jira today.
- Show it read-only on the detail screens; make it a clickable link.

---

## B3. "Keep updated" checkbox alongside Jira

**Intent:** Let the raiser opt in to having the request's external activity
pushed to their linked channel(s).

**Change:**
- Alongside Jira, add a **Keep updated** checkbox (boolean, default off) on the
  New workflow and request/support detail.
- Persist it on the request (e.g. `request.keep_updated`), exposed through the
  same create/detail/update contracts.

---

## B4. Push customer-visible activity to Jira / Teams when opted in

**Intent:** When the **Keep updated** box is ticked OR a **Teams chat link** has
been pasted (B2/B3), automatically post customer-facing activity to those
destinations.

**What to push (customer-visible only):**
- **External (customer) notes** — never internal notes.
- **Status changes** the customer should see.

**Destinations:**
- If a **Teams chat link** is present → post the update to that Teams chat.
- If **Keep updated** is ticked and a **Jira** number is present → add the update
  as a Jira comment / transition note.

**Notes / scope:**
- Trigger points: the external-note add path and the status-change path (both
  already audited). Hook the push there, after the DB transaction commits, so a
  delivery failure never rolls back the request change.
- Delivery should be best-effort and non-blocking (queue/async), with failures
  logged, not surfaced as request errors — mirror the existing
  `APEX_MAIL.PUSH_QUEUE` / notifications style if reusing that pattern.
- Requires outbound integration credentials/config for Jira and Teams (webhook
  or Graph API); flag as an external dependency.
- Explicitly EXCLUDE internal notes and internal-only audit entries from any
  push (same visibility rule the detail view already enforces for non-support
  viewers).

---

## B5. Allow Team Leaders to grant Task Maintenance access

**Intent:** Allow a team member to maintain tasks for a team

**Notes / scope:**

The Team Leader can check a box next to the name of an individual in the team when managing team membership. This check box instructs the tool to allow the individual to maintan and add tasks for that team.

Extend the admin section so that it also shows up if the individual has the option to maintain tasks. The user should only see the option to maintain tasks.

The user should not see or be able to maintain the team and team membership unless they are already the team leader and/or an administrator.

---

## B6. Change what is displayed under requests "My Team"

**Intent:** Resolve the content of "My Team"

**Notes / scope:**

The "My Team" screen should include all teams the member is in, uncluding the user itself.

"My Team" should mean: Identify every team the user is in and display all the requests including the user itself.

---

## B7. Add "Team" drop down when "My Team" on "Requests" is selected

**Intent:** Allow user to select 

**Notes / scope:**

Add to "My Team" a drop down list of teams that the user is included in at the top the option of "All" which is the default. If a team is selected from the list then the records are filtered to that team. If "All" is selected then all the teams the user is in are presented.

. If the user is in one team, do not display this drop down list.
. If "My Team" is not selected for display, do not display this drop down - only display the drop down when "My Team" is selected

If the user is in more than one team and "All" is selected then display the team name in the data window such that the screen is displayed in the format of:

Team : **Team**

Table of requests

Team: **Team**

Table of requests

---

## B8. Add "Subordinates" drop down to "Requests" if the user is a Line Manager.

**Intent:** Allow the user to see its line manager subordinates.

**Notes / scope:**

If the user is a manager then add an addition option alongside of "My Requests" and "My Team" titled "Subordinates".

"Subordinates" should mean: go up all accountd who has this user logged as ita manager, then show everyone in that manager's subtree (the manager and all their subordinates, cascading down). So it's the peer group — me, my siblings, and everyone below — rooted at me.

---

## B9. Email Updates

**Intent:** Send an email to the individual when a ticket they have raised is updated.

**Notes / scope:**

If the function fnc_send_email exists then send an email to the individual that the ticket has been updated. If the function which is supported externally does not exist then this service is not available. The sender should be "Helpdesk"

The email should be of the form:

1. Title: Helpdesk Ticket **Type** (**ID**) Updated
2. Description:

**Explain the change**
URL: **URL direct to ticket**

