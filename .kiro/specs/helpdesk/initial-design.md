# Overview

The tool is designed to allow users to raise requests for work and track their progress from start to end.

# Architecture

The application is a browser-based tool with a JavaScript/Angular frontend (latest Angular), following the design pattern outlined in the ui-foundations steering file. Users access the tool through a web browser.

The backend data store is PostgreSQL — the local `helpdesk` database, accessed as the `helpdesk` user. The Postgres MCP server is already configured against this database and can be used for development and deployment (schema creation, seed data, and queries).

## Runtime — Development (current)

For now the tool only needs to run locally on a development laptop. Whatever local runtime is required to serve the Angular application and connect it to PostgreSQL (for example a lightweight Node.js layer) is acceptable — the priority is simply that it runs and works end-to-end on the laptop. The specific serving mechanism is an implementation detail and is not prescribed here.

## Runtime — Deployment (future)

The eventual target is deployment into an Oracle database environment:
- **Static files** (the built Angular app) served via Oracle REST Data Services (ORDS).
- **Authentication** handled by Oracle Identity Cloud Service (IDCS).

The design should keep the frontend and its data-access concerns loosely coupled so that this later migration (swapping the local runtime/auth for ORDS + IDCS, and potentially the data store) is not blocked by early implementation choices.


# Audit

Every change of value should be recorded to show who made the change, what field was changed, previous value and new value.

The audit table should store the audit records at column (field) level.

A request should always record the date created and last updated

# Special

All dates should be recorded with timezone. Dates presented back to the user should always be presented in local date/time as per their PC.

# Security

The tool prompts for a username and password during login. The username for the benefit of testing should be a drop down of each person created and their surname set to their role, for example 11111111 Jason (Administrator) Hughes, 22222222 John (Support) Smith.

The username/password login described here is a development stand-in. In the eventual ORDS/IDCS deployment, authentication is delegated to IDCS and this local login is replaced. The application should treat "who is the current user" as a single resolved identity so the auth source can be swapped without touching the rest of the app.


# During development

All user accounts should have their password set to password1. In the table the password should be hashed.

## Administrators

An administrator who can manage teams and data points

## Users

A selection of users should be created who will have several requests raised by them over the teams and ticket types. Each user should have several requests raised and in a selection of states, ensuring the ticket has gone through the status routes.

## Teams

At least 5 teams each of which have a team leader and at least 5 members (who can also be users). Each team should have at least 3 ticket types against them.

Each team leader should have 2 team members who are themselves managers to 2 users.

# Layout and Design

The tool has the following key menu options 

## New

This option is used by the user to raise a request. Every user of the tool can see this option and they can select any team/task.

This is managed by a workflow of the following steps:

### Step 1: Team and Task

1. Select a team from the drop down which then presents that teams task list, which the user also selects.
2. User can press cancel to come out of the screen
3. User can press Next to move onto the next step of the workflow

#### Unknown/Unlisted

A default option of "Unknown/Unlisted" is displayed as a default task. This displays a Warning prompt "Warning: Only use if a Task does not match requirements. If a task type exists already the request may be rejected", the user selects "Acknowleged". The reques details if the user has selected this type is a simple "Details" box where the user can enter all the required details.

### Step 2: Request Details

1. User is presented with all the fields defined by the task. If a field has a description or help information a ? is added next to the field that the user can click to display. At a minimum fields defined as mandatory must be completed before the user can progress to the next screen. The data types of the field must be honoured and date and date + time fields should use appropriate popups to capture the data rather than have it typed.
2. One additional field of Jira is always presented, which is optional
3. User can press cancel to come out of "New"
4. User can press previous to return to the last step
5. User can press next to move to the next screen (only if all mandatory fields are complete)

### Step 3: Review

1. User is presented with a summary of the request. This can be obtained by accessing the locally running Ollama model which is running as a service. If the service is unavailable then display the values entered by the user.
2. User can press cancel to come out of "New"
3. User can press previous to return to the last step
4. User can press Submit to raise the request

When clicking Submit, the request is raised and given a unique task reference, and set to a status of "New"

## Requests

Only users who have raised requests or requests exist which map through the manager hierarchy can see this screen.

This screen is used by users to see the progress of tasks they have raised or their team has.
Within this screen all tasks are displayed.
Along the top is the following:
1. A search box which will search on any field but only within the scope of the toggle
2. Toggle between "My Requests" and "My Team": Default "My Requests". Makes the list filter just tasks raised by the individual, or anyone under the manager of the individual, which can be hierarchical, ie not just that level but work down any employees who are under that manager and anyone under these people if they are managers of people themselves.
3. Hide Complete - Check Box, Default checked. This will filter the list so that completed, rejected or cancelled tasks are not displayed.

Under the search bar is a table of requests which match the filter. The information provided on the screen is:

1. Task Number
2. Jira Number
3. Title
4. Date Raised
5. Status with a bracket " (Working On)" if anyone has an open timer against it and the ticket is not closed.
6. Support Team
7. Assigned Team Member
8. Last Updated
9. Estimated Start Date (entered manually by the support member owning the ticket)
10. Actual Start Date (This can be in the future)
11. Estimated Effort (calculated based on a sum of all timers for a ticket which has a status of completed divided by the number of completed tickets).
12. "Updated" if the request has had anything changed since the user last clicked on it.

When a user clicks on the request, all the information about the ticket is presented along with an audit trail of all changes excluding support team internal notes.

The user can add new notes to the ticket, for example additional information or to respond to a question asked by the support team member. The user can also update the Jira number, or any of the user entered fields ensuring mandatory fields can not be blanked out.

At any time while the request is not in a closed state, the person who raised the request can click on a button titled "Cancel" which will change the requests status to Cancelled. 
If the ticket is in cancelled state and the original person who created the ticket put it into cancelled state they will get a button titled "Reopen" which will move the cancelled request back to "New".
A user can't change the status under any other circumstance or to any other value.
When viewing a ticket their is always a button titled "Clone" which will create a new ticket and open it on step 2 of the workflow, with all the original values of this ticket and a status of New.

## Support

The screen displayed is the same as that seen in "Requests" however the search bar options are different:

1. A search box which will search on any field but only within the scope of the toggle and drop down
2. "Team" which is a drop down list of teams the individual is in with the additional option of "All" which means all teams the user is in.
3. Toggle between "My Queue" and "Team Queue": Default "My Queue". Makes the list filter just tasks assigned to the individual, or anyone within the team identifed in the team drop down (or all teams the user is in if "All" selected).
4. Hide Complete - Check Box, Default checked. This will filter the list so that completed, cancelled or rejected tasks are not displayed.
5. Show Unassigned - Check Box, Default checked. This will include or remove tickets which have not been assigned.

When the support user selects a request, they can update any fields including the status, for example changing it from New to Triage, and logging who will be owning the request within the team.
Any team member can assign a ticket to any other team member.
The user can also add notes which are presented back to the person looking at it via the requests screen.
The user can also add internal notes which do not present back to the user of the requests screen, just other support team users accessing the ticket under the support menu. An update of the internal notes does not trigger the "Updated" field to be triggered for the users screen but does present updated in the support screen. All other changes do 
Everything changed is captured in an audit trail
The support user has a button titled "Working on It" with a timer symbol against it. This only shows when the status is Active, and doesn't change the status, ie it stays Active, just that we are recording how much time we are working on the request while its in an active state. When clicked a timer is started for that support user against that ticket. The button changes to "Back to Queue" with a timer symbol next to it. When the user clicks "Back to Queue" a pop up is displayed which shows how long the timer lasted from the time they "Working on It" until the time they clicked "Back to Queue". The user can keep the time presented, which is in Days, Hours and Minutes, or update it and then clicking the "Confirm" option to save it. If the user updates the time, that value must be greater than 1 minute.This will record how long that time slice was for the ticket. Multiple people can have time slices recorded against the ticket and an individual can have more than one time slice recorded against the ticket. The combined time of all time slices are used to report on the average time the ticket type takes. All the timeslices and who recorded them should be retained.
If a support person clicks "Working on It" and they already have a timer running on another ticket then they should be prompted to ask if Current Timer(s) should be changed to "Back to Queue" or left running.

### Changing Types

A button is shown tited "Change Type". If clicked then the support person is presented with a "Cahange Type" popup where they select the type and click "Next". This will display a screen where the left side is the current request broken down by the respestive fields and to the right the fields for the new type. Where the same field is used in both then this is auto-populated, else the new fields are blank. The support person completes the new form and clicks "Switch". This will cause the form to be saved under the new type. A customer note is auto generated which outlines the before and after fields/values.

### Closing a Request

When selecting a closure status (Complete, Rejected, Cancelled) the support person is prompted to enter a final note to the customer before clicking "Close". In addition a button "Support Instructions" is shown. If clicked then the current support instructions are presented in edit mode and the user can update or add to them and click save before returning to this screen to click "Close".

## User Statistics

This is a page of statistics related to the individuals requests. It shows the following information

1. A stacked bar chart of number of tickets by each status broken down by month based on the users timezone.
2. A pie chart of number of tickets by type the individual has raised
3. To the right of 2. is another pie chart which represents the total time of all requests broken down by ticket type, for example I can see that 20% of all time worked on tickets for me are for a specific ticket type.
4. A summary table which shows ticket type, number of tickets raised, Number of tickets per status, average time from New to Triage, Average lifespace from Triage to a completed status - rejected and cancelled should be ignored 

## Team Statistics

Similar to the User Statistics but the charts are filtered against everyone who is associated to the same line manager including any sub managers which individuals have people linked to them under the manager field.

## Support Statistics 

This page represents statistics at the support team level. 

The user is presented at the top a list of teams they are associated with and the additional option of "All Teams" which will present statistics for every team they are in at the same time.

The reports show

1. A stacked bar chart of number of tickets by each status broken down by month based on the users timezone
2. A table with one dimension being task (or if All teams selected present as "Team - Task"). The other dimension being the names of all the members of the team(s). The data in the middle is the total number of tickets assigned to that individual regardless of status.
3. A table the same as 2 but the cells are the average duration from accepted to completed for tickets associated to that person. rejected and cancelled should be excluded.

## Administer

### Tool Administrator 

The administer option presents the user (if they are in the administrator group) with tiles that do the following

#### Teams

This screen allows the administrator to create a new team and assign it to a team leader. It also displays in a table existing teams which they can update to a different owner or close it. Closing a team means the team is not displayed in selection menus when creating a new ticket but existing tickets remain in the system. 

#### Data Points

This screen allows the administrator to see all existing data points defined. Here the user gives the data point a name, description and data type. A help text entry can also be recorded against the default which is the default and can be overriden when used in a task.

The administrator can also retire a data point which means it can't be selected for any new task definition but will remain operational for any task definition that is currently using it.

### Team Leader

If the user is a team leader they are presented with the tiles:

#### Teams

The team leader can manage who is in the team that has been assigned to them.

#### Tasks

The team leader can update the task fields for a task. Within this tool the team leader can create new tasks or update existing ones. Details that can be changed are:

1. The field order
2. The fields involved
3. The values for dropdowns to override the default
4. Task support notes
5. Task Instructions

When updating an existing task, a version should be maintained so that existing requests which use the task persist the version which was in use at the time. New requests are presented with the new layout.

# Definitions

## User

A user is someone who will create requests in the tool for Support Members to work on. A user's dataset includes:

1. username (digits to the length of 8)
2. Username which is of the form firstname surname
3. Email address
4. Manager username

When reviewing manager hierarchy, the hierarchy always starts at the manager of the individual, then takes into consideration those who have them logged as manager, and if any of these are managers themselves, those assigned to that manager. This cascades down until no more managers and their employees are added, for example:

User 1 is the area manager
User 2 has a Manager of User 1
User 3 has a Manager of User 1
User 4 has a manager of User 2 

So if user 2 is connected then user 1, 2, 3 and 4 are included
So if user 4 is connected then user 2 and 4 are included

If a user is marked as an area manager, then the manager hierarchy does not include their manager but starts at them. This needs to be stored in a separate lookup table and not the core datasource for users.

A user can be a user who can create tickets, a team leader if they have been assigned a team, and a manager at the same time. The superset of roles dictates which menu items they see.

## Support Members

Individual linked to one or more Support Team.
A support team member can also be a user
A support team member can be removed from a team but only if they do not have any none closed requests associated with them under that team.

## Support Team

A team is a group of Support Members who can be assigned work assigned to the team.
Each support team has a title, description, team leader and a list of members.
A team can be closed but only if it has no associated requests which are not closed. 

## Team Leader

The user recorded as the team leader for a team is responsible for:

1. Update the details of the team
2. Change the team membership
3. Create tasks under that team

## Administrator

Users who have been designated as administrators of the tool. 
These users can create teams and assign/change the team leader. 
The administrators are also responsible for maintaining the list of data points.

## Data Points

A data point is a piece of information that can be added to a task definition.
Each data point captures a name, data type, description and default help text.
Data Types supported are Text, Email Address, Date, Numeric, Date+Time, Time, Boolean, Dropdown and Regexp.
The regexp will be a regular expression format that the users data will have to match.
A Dropdown will allow the administator to define an initial list but the person defining the task and its datapoints can override the default list.
When a task is created which will have multiple fields which map to the data points, the task can override the description and help text but not the name or data type.

## Request

A request is a unit of work that needs to be done. A user can raise requests, select a team and then select a task, after which they can complete the data requirements before saving.

## Task

A task is a defined type of activity that can be requested. 
Each team can have one or more tasks. 
Only the team leader can create or edit tasks linked to the team.
Each task has one or more fields which are used by the users to capture the relevant information.
A task can be retired which means it can't be selected any more but will remain for requests already raised which uses it.
A task can also record support notes on how to carry out the request, which are presented via a "Help" button to the support team member working on the request.

## Task Fields

A task field is selected from the available supported data points managed by the administrators
A task field captures core information about the task.
A task field can override the default help text recorded against the data point

## Status

A request can be one of the following status:

1. New (default when created)
2. Triage 
3. Accepted
4. Assigned
5. Active
6. Paused
7. Blocked
8. Rejected
9. Cancelled
10. Complete

New is the initial one assigned when a ticket is raised.
Rejected, Cancelled and Complete are all Stop status values

Typical routes through the status fields (excluding the options to always go to cancelled or rejected at any time for simplicity) are:

a - Tickets will always move from New > Triage, 
b - Triage goes to either Accepted or Rejected
c - Accepted will go to Assigned
d - Assigned will go to Active, Paused or Blocked
e - Paused and Blocked can only go to Active
f - Active goes to Complete, Paused or Blocked

A ticket can only reach complete from active

A ticket can move to Cancelled from any non-stop states