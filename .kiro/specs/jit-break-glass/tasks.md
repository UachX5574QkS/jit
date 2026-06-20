# Implementation Plan: JIT Break Glass

## Overview

This plan implements the JIT Break Glass self-service tool as a React SPA deployed in an Oracle APEX workspace, with PL/SQL packages for business logic, ORDS REST modules for API access, and APEX Workflows for lifecycle orchestration. Implementation proceeds from database schema through PL/SQL packages, ORDS modules, APEX Workflows, and finally the React front-end, ensuring each layer builds on the previous.

## Tasks

- [ ] 1. Set up database schema and core tables
  - [ ] 1.1 Create IDCS_TENANCY table with identity column, unique constraint on tenancy_identifier, and all required columns (stripe_url, client_id, client_secret, created_at, updated_at)
    - Include DEFAULT SYSTIMESTAMP for timestamp columns
    - _Requirements: 2.1_

  - [ ] 1.2 Create BREAK_GLASS_EVENT table with identity column, foreign key to IDCS_TENANCY, CHECK constraints for event_type IN ('GROUP','PASSWORD'), start_time < end_time, ticket_reference length, and description length
    - Include status DEFAULT 'started' and all columns per design
    - _Requirements: 4.4, 9.6, 13.1_

  - [ ] 1.3 Create EVENT_STATUS_HISTORY table with identity column, foreign key to BREAK_GLASS_EVENT, and all columns (from_status, to_status, changed_by, change_reason, changed_at)
    - _Requirements: 13.5_

  - [ ] 1.4 Create PASSWORD_REVEAL_LOG table with identity column, foreign key to BREAK_GLASS_EVENT, and all columns (requesting_user, revealed_at, reset_scheduled_at, reset_completed_at, reset_status, retry_count)
    - _Requirements: 11.4, 11.7_

  - [ ] 1.5 Create all indexes defined in the design (idx_bge_requesting_user, idx_bge_approver, idx_bge_status, idx_bge_type_status, idx_esh_event_id, idx_prl_event_id, idx_prl_reset_status)
    - _Requirements: 12.1, 14.4_

- [ ] 2. Implement PKG_IDCS PL/SQL package (IDCS API Client)
  - [ ] 2.1 Create PKG_IDCS package spec with procedures/functions: get_oauth_token, get_user_groups, add_group_member, remove_group_member, set_user_password, get_group_members
    - Define parameter types and return types
    - _Requirements: 1.1, 2.4_

  - [ ] 2.2 Implement PKG_IDCS package body with OAuth token management (retrieve token using stored client_id/client_secret, cache token until expiry)
    - Use UTL_HTTP or APEX_WEB_SERVICE for HTTPS calls with 30-second timeout
    - _Requirements: 1.1, 2.4, 2.5_

  - [ ] 2.3 Implement get_user_groups: call IDCS /Groups endpoint filtered by user, parse JSON response, return group name collection
    - _Requirements: 1.1, 1.2_

  - [ ] 2.4 Implement add_group_member and remove_group_member: call IDCS /Groups/{id}/members endpoint with PATCH to add/remove user
    - _Requirements: 7.1, 7.3_

  - [ ] 2.5 Implement set_user_password: call IDCS /Users/{id} endpoint with PATCH to set password value
    - _Requirements: 11.2, 11.4_

  - [ ] 2.6 Implement get_group_members: call IDCS /Groups endpoint to list members of a given group, parse JSON response, return member collection (username, display_name, email)
    - _Requirements: 5.1, 10.2_

- [ ] 3. Implement PKG_PASSWORD PL/SQL package (Password Operations)
  - [ ] 3.1 Create PKG_PASSWORD package spec with functions: generate_password, schedule_password_reset
    - _Requirements: 11.2, 11.4_

  - [ ] 3.2 Implement generate_password: produce a cryptographically random string of at least 16 characters containing at least one uppercase letter, one lowercase letter, one digit, and one special character
    - Use DBMS_RANDOM or DBMS_CRYPTO for secure randomness
    - _Requirements: 11.2_

  - [ ] 3.3 Implement schedule_password_reset: insert PASSWORD_REVEAL_LOG record with reset_scheduled_at = revealed_at + 15 minutes, initiate WF_PASSWORD_RESET workflow
    - _Requirements: 11.4, 11.7_

- [ ] 4. Implement PKG_BREAK_GLASS PL/SQL package (Business Logic)
  - [ ] 4.1 Create PKG_BREAK_GLASS package spec with procedures/functions: validate_request, create_event, update_event_status, get_user_events, get_event_detail, authorize_user_for_event
    - _Requirements: 4.4, 9.6, 14.4_

  - [ ] 4.2 Implement validate_request: enforce all validation rules (start_time not in past, start < end, duration <= 72h for GROUP type, ticket_reference 1-100 chars trimmed, description 1-500 chars)
    - Return structured error details per field on failure
    - _Requirements: 4.2, 4.3, 9.2, 9.3, 9.4_

  - [ ] 4.3 Implement create_event: insert BREAK_GLASS_EVENT record, insert initial EVENT_STATUS_HISTORY record, return event_id
    - _Requirements: 4.4, 9.6_

  - [ ] 4.4 Implement update_event_status: update BREAK_GLASS_EVENT.status, insert EVENT_STATUS_HISTORY record with from_status, to_status, changed_by, change_reason, changed_at
    - _Requirements: 13.5_

  - [ ] 4.5 Implement get_user_events: query BREAK_GLASS_EVENT where requesting_user = current user OR approver_username = current user, ordered by created_at DESC
    - _Requirements: 12.1, 14.4, 14.7_

  - [ ] 4.6 Implement authorize_user_for_event: verify requesting user is the event owner or the designated approver; raise exception on failure
    - _Requirements: 14.4, 14.5_

- [ ] 5. Implement PKG_NOTIFICATIONS PL/SQL package (Email)
  - [ ] 5.1 Create PKG_NOTIFICATIONS package spec and body with procedures: notify_approver, notify_requester_approved, notify_requester_denied, notify_requester_expired, notify_revocation_failed
    - Use APEX_MAIL.SEND for email delivery
    - Include requesting user, target, time window, ticket reference, and action link in approval notifications
    - _Requirements: 6.1, 6.3, 6.4, 7.4, 7.5, 7.6, 10.1, 10.5, 10.6_

- [ ] 6. Checkpoint - Database layer complete
  - Ensure all PL/SQL packages compile without errors, ask the user if questions arise.

- [ ] 7. Create ORDS REST modules
  - [ ] 7.1 Create jit_auth module (base path /jit/v1/auth/) with GET handler that calls PKG_IDCS.get_user_groups for the authenticated APEX session user and returns JSON group list
    - _Requirements: 1.1, 14.2_

  - [ ] 7.2 Create jit_targets module (base path /jit/v1/targets/) with GET handler that returns group_targets and password_targets arrays based on the user's group memberships
    - Call PKG_IDCS.get_user_groups, apply combination detection logic, filter by user membership
    - _Requirements: 3.1, 3.2, 8.1, 8.2_

  - [ ] 7.3 Create jit_targets approvers endpoint (GET /jit/v1/targets/:type/:name/approvers) that calls PKG_IDCS.get_group_members for the relevant approvers group, excluding the requesting user
    - _Requirements: 5.1, 10.2_

  - [ ] 7.4 Create jit_events module (base path /jit/v1/events/) with POST handler that calls PKG_BREAK_GLASS.validate_request and PKG_BREAK_GLASS.create_event, initiates APEX workflow on success
    - Return 201 with event_id, status, created_at on success; return error response on validation failure
    - _Requirements: 4.4, 4.5, 9.5, 9.6, 14.1_

  - [ ] 7.5 Create jit_events GET handler that calls PKG_BREAK_GLASS.get_user_events and returns events array
    - _Requirements: 12.1, 14.7_

  - [ ] 7.6 Create jit_password module (base path /jit/v1/password/) with POST /reveal handler that validates preconditions (status = approved, current time within time window), calls PKG_PASSWORD.generate_password, calls PKG_IDCS.set_user_password, inserts PASSWORD_REVEAL_LOG, initiates WF_PASSWORD_RESET, returns password and expires_in_minutes
    - Return error if preconditions not met
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 14.3, 14.6_

  - [ ] 7.7 Create jit_approvals module (base path /jit/v1/approvals/) with PUT /:event_id handler that validates approver authorization, accepts APPROVE or DENY action, calls PKG_BREAK_GLASS.update_event_status, signals APEX workflow to proceed
    - _Requirements: 6.2, 6.3, 10.4, 10.5_

  - [ ] 7.8 Create jit_admin module (base path /jit/v1/admin/) with CRUD handlers for IDCS_TENANCY records (GET list, GET by id, POST create, PUT update, DELETE)
    - Restrict to admin role
    - _Requirements: 2.1, 2.2, 2.3_

- [ ] 8. Checkpoint - ORDS layer complete
  - Ensure all ORDS modules are defined and handlers compile without errors, ask the user if questions arise.

- [ ] 9. Create APEX Workflow definitions
  - [ ] 9.1 Create WF_GROUP_BREAK_GLASS workflow definition with activities: start → send_approval_notification → wait_for_approval → (branch: approved/denied/expired) → grant_elevated_access → wait_until_end_time → revoke_elevated_access → end
    - Configure wait_for_approval with deadline = start_time (expire if not actioned)
    - Configure retry on grant/revoke IDCS calls (3 retries, 30s interval)
    - On revocation failure: set status to revocation_failed, notify user and approver
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 13.1, 13.2, 13.6, 13.7_

  - [ ] 9.2 Create WF_PASSWORD_BREAK_GLASS workflow definition with activities: start → send_approval_notification → wait_for_approval → (branch: approved/denied/expired) → end
    - Configure wait_for_approval with 72-hour deadline
    - On approval: update status to approved (password reveal handled by ORDS endpoint on demand)
    - _Requirements: 10.1, 10.4, 10.5, 10.6, 13.3, 13.4_

  - [ ] 9.3 Create WF_PASSWORD_RESET workflow definition with activities: start → wait_15_minutes → reset_password → end
    - Call PKG_PASSWORD.generate_password and PKG_IDCS.set_user_password
    - Configure retry on reset failure (3 retries, 1-minute interval)
    - On success: update PASSWORD_REVEAL_LOG.reset_status = 'completed', reset_completed_at = SYSTIMESTAMP
    - On failure after retries: update reset_status = 'failed', log for admin review
    - _Requirements: 11.4, 11.7, 13.6, 13.7_

- [ ] 10. Checkpoint - Backend complete
  - Ensure all workflows are valid and can be activated, ask the user if questions arise.

- [ ] 11. Set up React front-end project
  - [ ] 11.1 Initialize React TypeScript project with Vite, configure build output for APEX static file deployment, set up project structure (src/components, src/hooks, src/context, src/types, src/services, src/utils)
    - _Requirements: 1.1_

  - [ ] 11.2 Create TypeScript type definitions for all API responses and request payloads (BreakGlassEvent, TargetResponse, ApproverResponse, PasswordRevealResponse, ErrorResponse)
    - Match the interface contracts from the design document
    - _Requirements: 14.1_

  - [ ] 11.3 Create API service module (src/services/api.ts) with typed functions for all ORDS endpoints: getAuth, getTargets, getApprovers, createEvent, getEvents, revealPassword, actionApproval, adminTenancy CRUD
    - Use fetch with credentials for APEX session cookies
    - _Requirements: 14.1, 14.2, 14.3_

- [ ] 12. Implement authentication and target discovery components
  - [ ] 12.1 Create AuthProvider context (src/context/AuthProvider.tsx) that fetches user groups on mount via getAuth API call, stores groups in React context, handles loading and error states
    - On IDCS unreachable: display error, block app usage
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ] 12.2 Create TargetDiscovery utility (src/utils/targetDiscovery.ts) with functions: detectGroupCombinations(groups), detectUserCombinations(groups), filterByMembership(combinations, userGroups)
    - Implement group pattern matching: jit_<name>, jit_<name>_approvers, jit_<name>_elevated for groups; inf_idcsuser_<name>, inf_idcsuser_<name>_approvers, inf_idcsuser_<name>_elevated for users
    - _Requirements: 3.1, 3.2, 3.3, 8.1, 8.2, 8.3_

  - [ ]* 12.3 Write property test for target combination detection
    - **Property 1: Target Combination Detection**
    - **Validates: Requirements 3.1, 8.1**

  - [ ]* 12.4 Write property test for target filtering by membership
    - **Property 2: Target Filtering by Membership**
    - **Validates: Requirements 3.2, 3.3, 8.2, 8.3**

  - [ ] 12.5 Create TargetDiscovery component (src/components/TargetDiscovery.tsx) that uses AuthProvider context, calls the targets API, renders group targets and password targets lists, shows empty state messages
    - _Requirements: 3.2, 3.4, 8.2, 8.4_

- [ ] 13. Implement request form components
  - [ ] 13.1 Create form validation utilities (src/utils/validation.ts) with functions: validateTimeWindow(start, end, now, type), validateTicketReference(ref), validateDescription(desc)
    - validateTimeWindow: start >= now, start < end, duration <= 72h for GROUP type
    - validateTicketReference: trimmed length 1-100
    - validateDescription: length 1-500
    - _Requirements: 4.2, 4.3, 9.2, 9.3, 9.4_

  - [ ]* 13.2 Write property test for time window validation
    - **Property 3: Time Window Validation**
    - **Validates: Requirements 4.2, 9.2**

  - [ ]* 13.3 Write property test for ticket reference validation
    - **Property 4: Ticket Reference Validation**
    - **Validates: Requirements 4.3, 9.3**

  - [ ]* 13.4 Write property test for description validation
    - **Property 5: Description Validation**
    - **Validates: Requirements 9.4**

  - [ ] 13.5 Create ApproverSelector component (src/components/ApproverSelector.tsx) that fetches approvers from API (excluding current user), renders dropdown for selection, handles auto-approval case when list is empty
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 10.2, 10.3_

  - [ ]* 13.6 Write property test for approver list filtering and auto-approval
    - **Property 6: Approver List Filtering and Auto-Approval**
    - **Validates: Requirements 5.1, 5.2, 5.3, 10.2, 10.3**

  - [ ] 13.7 Create GroupRequestForm component (src/components/GroupRequestForm.tsx) with fields for start time, end time, ticket reference, description, and ApproverSelector; validate on submit; call createEvent API; display field-level errors
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2_

  - [ ] 13.8 Create PasswordRequestForm component (src/components/PasswordRequestForm.tsx) with fields for start time, end time, ticket reference, description, and ApproverSelector; validate on submit; call createEvent API; display field-level errors
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 10.2_

- [ ] 14. Implement event tracking and password reveal components
  - [ ] 14.1 Create EventList component (src/components/EventList.tsx) that fetches events from API, displays sorted list (newest first) with status badges, shows empty state message, auto-refreshes every 30 seconds
    - _Requirements: 12.1, 12.3, 12.4_

  - [ ]* 14.2 Write property test for event list sort order
    - **Property 13: Event List Sort Order**
    - **Validates: Requirements 12.1**

  - [ ] 14.3 Create EventDetail component (src/components/EventDetail.tsx) that shows full event details including type, target, time window, ticket reference, description, approver, status, and status history timeline
    - _Requirements: 12.2_

  - [ ] 14.4 Create PasswordReveal component (src/components/PasswordReveal.tsx) that shows "Show Password" button only when status = approved AND current time is within time window, calls reveal API on click, displays password, handles errors
    - _Requirements: 11.1, 11.2, 11.3, 11.5, 11.6_

  - [ ]* 14.5 Write property test for show password button visibility
    - **Property 11: Show Password Button Visibility**
    - **Validates: Requirements 11.1, 11.5**

  - [ ]* 14.6 Write property test for password reveal precondition enforcement
    - **Property 12: Password Reveal Precondition Enforcement**
    - **Validates: Requirements 14.6**

  - [ ]* 14.7 Write property test for authorization-based event filtering
    - **Property 14: Authorization-Based Event Filtering**
    - **Validates: Requirements 14.4, 14.5, 14.7**

- [ ] 15. Implement admin and approval components
  - [ ] 15.1 Create AdminTenancyManager component (src/components/AdminTenancyManager.tsx) with CRUD interface for IDCS tenancy records: list view, create form, edit form, delete confirmation
    - All fields required; validate unique tenancy_identifier
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ] 15.2 Create ApprovalAction component (src/components/ApprovalAction.tsx) that displays pending approval details, provides Approve/Deny buttons with optional comment field, calls actionApproval API
    - _Requirements: 6.2, 6.3, 10.4, 10.5_

- [ ] 16. Implement state machine and workflow logic tests
  - [ ]* 16.1 Write property test for group workflow state machine validity
    - **Property 7: Group Workflow State Machine Validity**
    - **Validates: Requirements 6.2, 6.3, 6.4, 7.4, 7.5, 7.7, 13.1, 13.2**

  - [ ]* 16.2 Write property test for password workflow state machine validity
    - **Property 8: Password Workflow State Machine Validity**
    - **Validates: Requirements 10.4, 10.5, 10.6, 13.3, 13.4**

  - [ ]* 16.3 Write property test for workflow transition timestamps
    - **Property 9: Workflow Transition Timestamps**
    - **Validates: Requirements 13.5**

  - [ ]* 16.4 Write property test for password generation complexity
    - **Property 10: Password Generation Complexity**
    - **Validates: Requirements 11.2**

  - [ ]* 16.5 Write property test for invalid submissions producing no side effects
    - **Property 15: Invalid Submissions Produce No Side Effects**
    - **Validates: Requirements 4.5, 9.5**

- [ ] 17. Wire together App shell and routing
  - [ ] 17.1 Create App component (src/App.tsx) with routing: wrap in AuthProvider, define routes for target discovery (/), event list (/events), event detail (/events/:id), admin (/admin), and approval action (/approvals/:id)
    - _Requirements: 1.1, 12.1, 12.2_

  - [ ] 17.2 Configure Vite build for APEX static file deployment: set base path, output to dist/, configure proxy for local development against ORDS endpoints
    - _Requirements: 1.1_

- [ ] 18. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using fast-check
- Unit tests validate specific examples and edge cases
- Database layer (tasks 1-6) must be complete before ORDS layer (tasks 7-8)
- ORDS layer must be complete before workflow definitions (tasks 9-10)
- React front-end (tasks 11-17) can begin after API contracts are defined but testing requires ORDS availability
- PL/SQL packages use APEX_WEB_SERVICE or UTL_HTTP for IDCS REST calls
- All ORDS handlers validate authentication via APEX session before processing

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["1.5", "2.1", "3.1", "4.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4", "2.5", "2.6", "3.2", "3.3", "4.2", "4.3", "4.4", "4.5", "4.6", "5.1"] },
    { "id": 4, "tasks": ["7.1", "7.2", "7.3", "7.4", "7.5", "7.6", "7.7", "7.8", "11.1"] },
    { "id": 5, "tasks": ["9.1", "9.2", "9.3", "11.2", "11.3"] },
    { "id": 6, "tasks": ["12.1", "12.2", "13.1"] },
    { "id": 7, "tasks": ["12.3", "12.4", "12.5", "13.2", "13.3", "13.4", "13.5"] },
    { "id": 8, "tasks": ["13.6", "13.7", "13.8", "14.1"] },
    { "id": 9, "tasks": ["14.2", "14.3", "14.4", "14.7", "15.1", "15.2"] },
    { "id": 10, "tasks": ["14.5", "14.6", "16.1", "16.2", "16.3", "16.4", "16.5"] },
    { "id": 11, "tasks": ["17.1", "17.2"] }
  ]
}
```
