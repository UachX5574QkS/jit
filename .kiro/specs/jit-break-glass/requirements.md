# Requirements Document

## Introduction

JIT Break Glass is a self-service tool that enables users to request temporary elevated access through break-glass events. The application supports two break-glass types: IDCS Group elevation and IDCS User Password retrieval. Users can raise requests, track progress, and manage their workflow through a React-based interface deployed within an Oracle APEX workspace. The tool integrates with Oracle IDCS for group membership, uses an OCI Autonomous Database for persistence, and leverages Oracle APEX Workflows for approval and lifecycle management.

## Glossary

- **IDCS**: Oracle Identity Cloud Service, the identity provider managing users and groups
- **IDCS_Tenancy**: A configured IDCS tenancy record stored in the application database, containing connection details and authentication keys
- **Break_Glass_Event**: A time-bounded request for temporary elevated access, initiated by a user
- **JIT_Application**: The React/JavaScript front-end application deployed as static files in an Oracle APEX workspace, using ORDS for database interaction
- **ORDS**: Oracle REST Data Services, providing RESTful API access to the Oracle database
- **APEX_Workflow**: Oracle APEX Workflow engine used to orchestrate multi-step approval and lifecycle processes
- **Group_Combination**: The set of three IDCS groups (jit_\<group\>, jit_\<group\>_approvers, jit_\<group\>_elevated) that together define a valid group break-glass target
- **User_Combination**: The set of three IDCS groups (inf_idcsuser_\<user\>, inf_idcsuser_\<user\>_approvers, inf_idcsuser_\<user\>_elevated) that together define a valid user password break-glass target
- **Approver**: A member of the corresponding _approvers group who is authorized to approve or deny a break-glass request
- **Elevated_Group**: The IDCS group suffixed with _elevated that grants temporary elevated permissions
- **Time_Window**: The start and end datetime defining the period of elevated access
- **Request_Ticket**: An external reference identifier such as an MCR number or Incident number associated with a break-glass request
- **Password_Reset_Workflow**: A background process that changes an IDCS user password to a new unique value 15 minutes after the initial password reveal
- **IDCS_Audit_Events**: The audit log entries recorded by IDCS for user actions during a session, including login, logout, group membership changes, API calls, and administrative operations performed by or on behalf of a user
- **My_Requests_Screen**: The in-app screen showing all break-glass requests submitted by the authenticated user
- **My_Approvals_Screen**: The in-app screen showing all break-glass requests assigned to the authenticated user as an approver

## Requirements

### Requirement 1: User Authentication and Group Extraction

**User Story:** As a user, I want to log into the JIT application and have my IDCS group memberships automatically retrieved, so that I can see which break-glass options are available to me.

#### Acceptance Criteria

1. WHEN a user authenticates with the JIT_Application, THE JIT_Application SHALL retrieve the list of IDCS groups the user is a member of from the configured IDCS_Tenancy within 30 seconds of the authentication event
2. WHEN the IDCS group list is retrieved, THE JIT_Application SHALL store the group memberships for use until the user's session ends through logout or inactivity timeout
3. IF the IDCS_Tenancy is unreachable during authentication (no response within 30 seconds), THEN THE JIT_Application SHALL display an error message indicating the identity service is unavailable and prevent the user from proceeding to the application
4. IF the IDCS_Tenancy is reachable but returns an error response during group retrieval, THEN THE JIT_Application SHALL display an error message indicating that group memberships could not be loaded and prevent the user from proceeding to the application
5. WHEN the IDCS group list is retrieved and contains zero groups for the user, THE JIT_Application SHALL treat this as a successful authentication and display no available break-glass targets

### Requirement 2: IDCS Tenancy Configuration

**User Story:** As an administrator, I want the application to maintain a list of IDCS tenancies with their authentication keys, so that the system can connect to the correct identity services.

#### Acceptance Criteria

1. THE JIT_Application SHALL store IDCS_Tenancy records in a database table including the tenancy identifier (unique), IDCS stripe URL, and authentication keys, where all fields are required
2. THE JIT_Application SHALL provide administrator CRUD operations for creating, reading, updating, and deleting IDCS_Tenancy records
3. WHEN an administrator creates or updates an IDCS_Tenancy record, THE JIT_Application SHALL validate that the tenancy identifier is unique and all required fields are provided
4. WHEN the JIT_Application connects to an IDCS_Tenancy, THE JIT_Application SHALL use the stored authentication keys for that tenancy
5. IF an IDCS_Tenancy authentication key is invalid or expired, THEN THE JIT_Application SHALL log the authentication failure, display an error to the user, and not complete the failed operation

### Requirement 3: Group Break-Glass Target Discovery

**User Story:** As a user, I want to see which IDCS groups I can raise break-glass requests for, so that I can request the elevated access I need.

#### Acceptance Criteria

1. WHEN the user's IDCS group memberships are loaded, THE JIT_Application SHALL identify valid Group_Combinations by detecting sets of groups where all three groups exist: jit_\<group\>, jit_\<group\>_approvers, and jit_\<group\>_elevated. A combination is valid only when all three groups are present in the IDCS_Tenancy.
2. WHEN a valid Group_Combination is identified, IF the user is a member of the jit_\<group\> group, THEN THE JIT_Application SHALL display that group as an available break-glass target in the user's target list
3. WHEN a valid Group_Combination is identified, IF the user is not a member of the jit_\<group\> group, THEN THE JIT_Application SHALL not display that group as an available target
4. IF no valid Group_Combinations exist for which the user is a member of the jit_\<group\> group, THEN THE JIT_Application SHALL display an informational message indicating no group break-glass targets are available

### Requirement 4: Group Break-Glass Request Submission

**User Story:** As a user, I want to submit a break-glass request for an IDCS group, so that I can obtain temporary elevated access.

#### Acceptance Criteria

1. WHEN a user selects a group break-glass target, THE JIT_Application SHALL present a form requiring the start time, end time, request ticket reference, and description, where description accepts between 1 and 500 characters
2. WHEN a user submits a group break-glass request, THE JIT_Application SHALL validate that the start time is not in the past, that the start time is before the end time, and that the Time_Window duration does not exceed 72 hours
3. WHEN a user submits a group break-glass request, THE JIT_Application SHALL validate that a request ticket reference of at least 1 character and no more than 100 characters is provided
4. WHEN the submission is valid, THE JIT_Application SHALL create a Break_Glass_Event record and initiate an APEX_Workflow instance for the request
5. IF any validation check fails during group break-glass request submission, THEN THE JIT_Application SHALL not create a Break_Glass_Event record and SHALL display an error message indicating which validation check failed

### Requirement 5: Group Break-Glass Approver Selection

**User Story:** As a user, I want to select an approver from the designated approvers group, so that my request can be reviewed by an authorized person.

#### Acceptance Criteria

1. WHEN a user is submitting a group break-glass request, THE JIT_Application SHALL display the list of members from the corresponding jit_\<group\>_approvers group for selection, excluding the requesting user from the list
2. IF the jit_\<group\>_approvers group contains one or more members (excluding the requesting user), THEN THE JIT_Application SHALL require the user to select exactly one approver
3. IF the jit_\<group\>_approvers group is empty or contains only the requesting user, THEN THE JIT_Application SHALL automatically approve the break-glass request without requiring approver selection
4. IF the IDCS_Tenancy is unreachable when fetching the approvers list, THEN THE JIT_Application SHALL display an error message indicating that approvers could not be loaded and SHALL not allow submission

### Requirement 6: Group Break-Glass Approval Workflow

**User Story:** As an approver, I want to receive notification of break-glass requests and approve or deny them, so that elevated access is properly authorized.

#### Acceptance Criteria

1. WHEN a group break-glass request is submitted with a selected approver, THE APEX_Workflow SHALL send an email notification to the selected approver containing the requesting user's identity, the target group name, the Time_Window, the request ticket reference, and action buttons (or links) to directly approve or deny the request from within the email
2. WHEN an approver approves the request, THE APEX_Workflow SHALL update the Break_Glass_Event status to approved and proceed to grant the elevated access at the Time_Window start time or immediately if the current time is already within the Time_Window
3. WHEN an approver denies the request, THE APEX_Workflow SHALL update the Break_Glass_Event status to denied and send an email notification to the requesting user indicating the request was denied
4. IF the approval request is not actioned before the Time_Window start time, THEN THE APEX_Workflow SHALL update the Break_Glass_Event status to expired and send an email notification to the requesting user indicating the request has expired

### Requirement 7: Group Break-Glass Elevated Access Grant

**User Story:** As a user, I want to be granted elevated access upon approval, so that I can perform the work requiring break-glass access.

#### Acceptance Criteria

1. WHEN a group break-glass request is approved and the current time is within the Time_Window, THE APEX_Workflow SHALL add the user to the corresponding Elevated_Group in IDCS
2. WHEN a group break-glass request is approved and the current time is before the Time_Window start time, THE APEX_Workflow SHALL wait until the Time_Window start time and then add the user to the corresponding Elevated_Group in IDCS
3. WHEN the Time_Window end time is reached, THE APEX_Workflow SHALL remove the user from the Elevated_Group in IDCS
4. WHEN the user is added to the Elevated_Group, THE APEX_Workflow SHALL update the Break_Glass_Event status to active and send an email notification to the requesting user
5. WHEN the user is removed from the Elevated_Group, THE APEX_Workflow SHALL update the Break_Glass_Event status to revoked and send an email notification to the requesting user
6. IF the APEX_Workflow fails to remove the user from the Elevated_Group after exhausting retries, THEN THE APEX_Workflow SHALL update the Break_Glass_Event status to revocation_failed and send an email notification to the requesting user and the approver
7. IF a group break-glass request is approved after the Time_Window end time has passed, THEN THE APEX_Workflow SHALL update the Break_Glass_Event status to expired without adding the user to the Elevated_Group

### Requirement 8: User Password Break-Glass Target Discovery

**User Story:** As a user, I want to see which IDCS user accounts I can raise password break-glass requests for, so that I can request password access when needed.

#### Acceptance Criteria

1. WHEN the user's IDCS group memberships are loaded, THE JIT_Application SHALL identify valid User_Combinations by detecting sets of three groups that share the same \<user\> identifier and match all of the following patterns: inf_idcsuser_\<user\>, inf_idcsuser_\<user\>_approvers, and inf_idcsuser_\<user\>_elevated. A User_Combination is valid only when all three corresponding groups exist.
2. IF a valid User_Combination exists and the user is a member of the inf_idcsuser_\<user\> group, THEN THE JIT_Application SHALL display that IDCS user account name as an available password break-glass target.
3. IF a valid User_Combination exists but the user is not a member of the inf_idcsuser_\<user\> group, THEN THE JIT_Application SHALL not display that account as an available target.
4. IF the user has no valid User_Combinations where they are a member of the inf_idcsuser_\<user\> group, THEN THE JIT_Application SHALL display a message indicating no password break-glass targets are available.
5. IF loading the user's IDCS group memberships fails, THEN THE JIT_Application SHALL display an error message indicating that target discovery could not be completed and SHALL not display any targets.

### Requirement 9: User Password Break-Glass Request Submission

**User Story:** As a user, I want to submit a break-glass request for an IDCS user password, so that I can obtain temporary password access to that account.

#### Acceptance Criteria

1. WHEN a user selects a password break-glass target, THE JIT_Application SHALL present a form requiring the start time, end time, request ticket reference, description, and approver selection (populated from the inf_idcsuser_\<user\>_approvers group members)
2. WHEN a user submits a password break-glass request, THE JIT_Application SHALL validate that the start time is not in the past and is before the end time
3. WHEN a user submits a password break-glass request, THE JIT_Application SHALL validate that the request ticket reference contains at least 1 non-whitespace character
4. WHEN a user submits a password break-glass request, THE JIT_Application SHALL validate that the description contains between 1 and 500 characters
5. IF any submission validation fails, THEN THE JIT_Application SHALL display an error message indicating which field failed validation and shall not create a Break_Glass_Event record
6. WHEN the submission is valid, THE JIT_Application SHALL create a Break_Glass_Event record and initiate an APEX_Workflow instance for the request

### Requirement 10: User Password Break-Glass Approval Workflow

**User Story:** As an approver, I want to review password break-glass requests, so that password access is properly authorized.

#### Acceptance Criteria

1. WHEN a password break-glass request is submitted with a selected approver, THE APEX_Workflow SHALL send an email notification to the selected approver containing the requesting user's identity, the target account, and the stated justification
2. WHEN the inf_idcsuser_\<user\>_approvers group contains one or more members, THE JIT_Application SHALL require the user to select an approver from that group
3. IF the inf_idcsuser_\<user\>_approvers group is empty, THEN THE JIT_Application SHALL automatically approve the password break-glass request and record the approval reason as "no approvers configured"
4. WHEN an approver approves the request, THE APEX_Workflow SHALL record the approval and update the Break_Glass_Event status to approved
5. WHEN an approver denies the request, THE APEX_Workflow SHALL record the denial, update the Break_Glass_Event status to denied, and send an email notification to the requesting user indicating that the request was denied
6. IF a password break-glass request remains in pending status for more than 72 hours without an approver response, THEN THE APEX_Workflow SHALL update the Break_Glass_Event status to expired and send an email notification to the requesting user indicating that the request has expired

### Requirement 11: User Password Reveal

**User Story:** As a user, I want to reveal the password for an approved break-glass request during the active time window, so that I can access the target IDCS user account.

#### Acceptance Criteria

1. WHILE a password break-glass request is approved and the current time is within the Time_Window, THE JIT_Application SHALL display a "Show Password" button on the request form
2. WHEN the user clicks the "Show Password" button, THE JIT_Application SHALL set the target IDCS user password to a randomly generated value of at least 16 characters containing uppercase letters, lowercase letters, digits, and special characters via the IDCS API
3. WHEN the password is successfully set, THE JIT_Application SHALL display the new password to the user exactly once per click and replace any previously displayed password value
4. WHEN the "Show Password" action is triggered, THE JIT_Application SHALL initiate a Password_Reset_Workflow that changes the IDCS user password to a different randomly generated value after 15 minutes from the time the password was revealed
5. WHILE the current time is outside the Time_Window, THE JIT_Application SHALL not display the "Show Password" button
6. IF the IDCS API call to set the password fails, THEN THE JIT_Application SHALL display an error message indicating the password could not be set and SHALL NOT display a password value to the user
7. IF the Password_Reset_Workflow fails to reset the password after 15 minutes, THEN THE JIT_Application SHALL retry the reset up to 3 times at 1-minute intervals and SHALL log the failure for administrator review

### Requirement 12: My Requests Screen

**User Story:** As a user, I want a dedicated "My Requests" screen that shows all my break-glass requests, so that I can track their progress in one place.

#### Acceptance Criteria

1. THE JIT_Application SHALL provide a "My Requests" screen that displays a list of the user's Break_Glass_Events with their current status, sorted by creation date descending (newest first)
2. WHEN a user views a Break_Glass_Event from the "My Requests" screen, THE JIT_Application SHALL show the event details including type, target, time window, request ticket, description, approver, and current status
3. WHEN the APEX_Workflow progresses through its stages, THE JIT_Application SHALL reflect the updated status on the "My Requests" screen within 30 seconds of the stage transition
4. IF the user has no Break_Glass_Events, THEN THE JIT_Application SHALL display an informational message on the "My Requests" screen indicating no requests have been made

### Requirement 13: APEX Workflow Lifecycle Management

**User Story:** As the system, I want each break-glass event to follow a defined workflow, so that all steps are executed reliably and auditably.

#### Acceptance Criteria

1. WHEN a group break-glass APEX_Workflow is initiated and the request is approved, THE APEX_Workflow SHALL progress through the stages in order: started, approval_pending, approved_or_denied, grant_added, grant_revoked, audit_captured
2. WHEN a group break-glass APEX_Workflow is initiated and the request is denied, THE APEX_Workflow SHALL progress through the stages in order: started, approval_pending, approved_or_denied, and then terminate without proceeding to grant_added, grant_revoked, or audit_captured
3. WHEN a password break-glass APEX_Workflow is initiated and the request is approved, THE APEX_Workflow SHALL progress through the stages in order: started, approval_pending, approved_or_denied, password_revealed, password_reset, audit_captured
4. WHEN a password break-glass APEX_Workflow is initiated and the request is denied, THE APEX_Workflow SHALL progress through the stages in order: started, approval_pending, approved_or_denied, and then terminate without proceeding to password_revealed, password_reset, or audit_captured
5. WHEN the APEX_Workflow transitions between stages, THE APEX_Workflow SHALL record a UTC timestamp for the transition in the Break_Glass_Event record
6. IF a workflow step fails due to an IDCS API error, THEN THE APEX_Workflow SHALL retry the step up to 3 times with a minimum interval of 30 seconds between attempts and log the failure details for each attempt
7. IF a workflow step has failed after exhausting all 3 retry attempts, THEN THE APEX_Workflow SHALL mark the Break_Glass_Event status as error and cease further processing of that workflow instance

### Requirement 14: ORDS API Layer

**User Story:** As the front-end application, I want to interact with the database through RESTful APIs, so that the React application can manage break-glass events.

#### Acceptance Criteria

1. THE ORDS SHALL expose RESTful endpoints for creating, reading, and updating Break_Glass_Event records
2. THE ORDS SHALL expose RESTful endpoints for retrieving IDCS group membership data
3. THE ORDS SHALL expose a RESTful endpoint for triggering the "Show Password" action on approved password break-glass events
4. WHEN an ORDS endpoint receives a request, THE ORDS SHALL validate that the requesting user is authenticated and authorized for the operation, where authorized means the user is the owner of the Break_Glass_Event or is the designated approver for the event
5. IF authentication or authorization validation fails, THEN THE ORDS SHALL reject the request with an error response indicating the access denial reason and SHALL NOT return any event data
6. IF the "Show Password" endpoint is called for a Break_Glass_Event that is not in approved status or whose Time_Window has expired, THEN THE ORDS SHALL reject the request with an error response indicating the precondition that was not met
7. WHEN a read endpoint returns Break_Glass_Event records, THE ORDS SHALL return only records where the authenticated user is the event owner or the designated approver

### Requirement 15: Break-Glass Audit Trail Capture

**User Story:** As a security administrator, I want the system to capture all IDCS audit activity for the duration of a break-glass session, so that there is a complete accountability record of actions taken during elevated access.

#### Acceptance Criteria

1. WHEN the APEX_Workflow removes a user from the Elevated_Group at the end of the Time_Window for a group break-glass event, THE APEX_Workflow SHALL extract all IDCS_Audit_Events for that user from the IDCS_Tenancy covering the period between the Time_Window start time and the Time_Window end time
2. WHEN the IDCS_Audit_Events for a group break-glass event are extracted, THE APEX_Workflow SHALL attach the extracted audit data to the corresponding Break_Glass_Event record
3. WHEN the Time_Window end time is reached for a password break-glass event, THE APEX_Workflow SHALL extract all IDCS_Audit_Events for the target user account from the IDCS_Tenancy covering the period from the Time_Window start time up to and including the session end or logout event for that account
4. WHEN the IDCS_Audit_Events for a password break-glass event are extracted, THE APEX_Workflow SHALL attach the extracted audit data to the corresponding Break_Glass_Event record
5. IF the IDCS_Tenancy is unreachable when attempting to extract IDCS_Audit_Events, THEN THE APEX_Workflow SHALL retry the extraction up to 3 times at 5-minute intervals
6. IF the IDCS_Audit_Events extraction fails after exhausting all retry attempts, THEN THE APEX_Workflow SHALL update the Break_Glass_Event record with an audit_capture_failed status flag and send an email notification to the approver and a system administrator
7. WHEN IDCS_Audit_Events are attached to a Break_Glass_Event record, THE JIT_Application SHALL display an "Audit Trail" button on the corresponding Break_Glass_Event ticket in both the "My Requests" and "My Approvals" screens, and WHEN an authorized user clicks the "Audit Trail" button, THE JIT_Application SHALL display the captured IDCS_Audit_Events for that event to the event owner, the approver, and system administrators

### Requirement 16: Workflow Status Visualization

**User Story:** As a user, I want to see a visual diagram of the workflow for my break-glass request showing all steps and highlighting the current active step, so that I can understand where my request is in the process at a glance.

#### Acceptance Criteria

1. WHEN a user views a Break_Glass_Event detail, THE JIT_Application SHALL display a "Status" button on the event detail view
2. WHEN the user clicks the "Status" button, THE JIT_Application SHALL display the APEX_Workflow for that Break_Glass_Event as a visual diagram showing all steps in the workflow lifecycle
3. WHEN the workflow diagram is displayed, THE JIT_Application SHALL render each step of the workflow definition corresponding to the event type (group break-glass lifecycle or password break-glass lifecycle)
4. WHEN the workflow diagram is displayed, THE JIT_Application SHALL visually distinguish between completed steps, the current active step, and future pending steps using distinct visual indicators
5. WHEN the workflow diagram is displayed for a group break-glass event, THE JIT_Application SHALL render the steps matching the group workflow lifecycle: started, approval_pending, approved_or_denied, grant_added, grant_revoked, audit_captured
6. WHEN the workflow diagram is displayed for a password break-glass event, THE JIT_Application SHALL render the steps matching the password workflow lifecycle: started, approval_pending, approved_or_denied, password_revealed, password_reset, audit_captured
7. WHEN the APEX_Workflow progresses to a new stage, THE JIT_Application SHALL update the workflow diagram to reflect the new active step within 30 seconds of the stage transition
8. IF the Break_Glass_Event has reached a terminal state (denied, expired, error, revocation_failed, audit_capture_failed), THEN THE JIT_Application SHALL display the diagram with all reached steps marked as completed and no step highlighted as active

### Requirement 17: My Approvals Screen

**User Story:** As an approver, I want a dedicated "My Approvals" screen that shows all pending break-glass requests assigned to me, so that I can review, approve, or deny them from within the application.

#### Acceptance Criteria

1. THE JIT_Application SHALL provide a "My Approvals" screen accessible to any authenticated user who is designated as an approver on one or more Break_Glass_Events
2. WHEN an approver navigates to the "My Approvals" screen, THE JIT_Application SHALL display all Break_Glass_Events where the authenticated user is the designated approver, sorted by creation date descending (newest first)
3. WHEN the "My Approvals" screen is displayed, THE JIT_Application SHALL show for each pending request the requesting user's identity, the event type, the target identifier, the Time_Window, the request ticket reference, and the description
4. WHEN a pending request is displayed on the "My Approvals" screen, THE JIT_Application SHALL display "Approve" and "Deny" buttons for each request that has a status of approval_pending
5. WHEN an approver clicks the "Approve" button on the "My Approvals" screen, THE JIT_Application SHALL submit the approval action to the ORDS approvals endpoint and update the displayed status to approved upon success
6. WHEN an approver clicks the "Deny" button on the "My Approvals" screen, THE JIT_Application SHALL prompt for an optional comment, submit the denial action to the ORDS approvals endpoint, and update the displayed status to denied upon success
7. IF a Break_Glass_Event assigned to the approver is no longer in approval_pending status (expired, already actioned), THEN THE JIT_Application SHALL display the event with its current status and SHALL NOT display "Approve" or "Deny" buttons for that event
8. IF the approver has no Break_Glass_Events assigned to them, THEN THE JIT_Application SHALL display an informational message on the "My Approvals" screen indicating no approval requests are pending
