# JIT Break Glass - Project Steering

## Project Overview

JIT Break Glass is a self-service tool for requesting temporary elevated access through two mechanisms:
- **Group elevation**: Adding a user to an IDCS elevated group for a time window
- **Password retrieval**: Revealing a temporary IDCS user password that auto-resets after 15 minutes

The application is a React SPA deployed in an Oracle APEX workspace, backed by PL/SQL packages, ORDS REST APIs, and APEX Workflows on an OCI Autonomous Database.

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Database | Oracle 23ai Autonomous Database (23.26.2.2.0) |
| API | Oracle REST Data Services (ORDS) 26.1.2 |
| Workflows | Oracle APEX Workflows |
| Backend Logic | PL/SQL packages |
| Frontend | React 19 + TypeScript + Vite |
| Routing | react-router-dom (HashRouter for APEX static file compatibility) |
| Auth | APEX Authentication Scheme (IDCS OAuth2) |
| Identity | Oracle IDCS (Identity Cloud Service) |

## Database Connection

- **ORDS Base URL**: `https://ldldfcndl8jbd1z-jitdemodatabase.adb.uk-london-1.oraclecloudapps.com/ords/`
- **SQLcl Connection Name**: `jit_schema`
- **Database User**: `jit_schema`
- **Wallet**: `Wallet_jitdemodatabase.zip` (in project root)

## Project Structure

```
jit/
├── database/
│   ├── tables/           # DDL for all tables
│   ├── indexes/          # Index definitions
│   ├── packages/         # PL/SQL package specs (.pks) and bodies (.pkb)
│   ├── ords/             # ORDS module definitions (PL/SQL scripts)
│   └── workflows/        # APEX Workflow definitions
├── frontend/             # React TypeScript SPA (Vite)
│   ├── src/
│   │   ├── components/   # React components
│   │   ├── context/      # React context providers (Auth, Timezone)
│   │   ├── hooks/        # Custom React hooks
│   │   ├── services/     # API service + mock data
│   │   ├── types/        # TypeScript type definitions
│   │   └── utils/        # Utility functions (validation, target discovery)
│   └── vite.config.ts
├── Wallet_jitdemodatabase.zip
└── .kiro/
    ├── specs/jit-break-glass/  # Feature spec (requirements, design, tasks)
    └── steering/               # This file
```

## Coding Standards

### PL/SQL
- Package naming: `PKG_<domain>` (e.g., `PKG_IDCS`, `PKG_BREAK_GLASS`)
- Use `TIMESTAMP WITH TIME ZONE` for all date/time columns
- Use `SYSTIMESTAMP` (not `SYSDATE`) for current time
- Use `RAISE_APPLICATION_ERROR` with codes -20001 (validation), -20002 (authorization), -20003 (invalid status)
- Use `APEX_JSON` for building JSON responses in ORDS handlers
- Use `APEX_MAIL.SEND` + `APEX_MAIL.PUSH_QUEUE` for email delivery
- Session user: `NVL(:current_user, V('APP_USER'))`

### ORDS Modules
- Base path pattern: `/jit/v1/<resource>/`
- Use `ORDS.DEFINE_MODULE`, `ORDS.DEFINE_TEMPLATE`, `ORDS.DEFINE_HANDLER`
- Source type: `plsql/block`
- ISO 8601 format for dates: `'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'`
- Always validate authentication before processing

### TypeScript/React
- Strict mode enabled
- Use `import type` for type-only imports (verbatimModuleSyntax)
- Use functional components with hooks
- Context pattern: Provider + useContext hook
- API service uses `fetch` with `credentials: 'include'`
- Mock data in dev mode (`import.meta.env.DEV`)
- Timezone-aware date formatting via `TimezoneProvider` context
- ARIA attributes for accessibility

## Key Design Decisions

1. **HashRouter** (not BrowserRouter) — required for APEX static file deployment where there's no server-side routing
2. **Simulated IDCS calls** — `PKG_IDCS` body returns mock data; production would use `APEX_WEB_SERVICE` with 30s timeout
3. **Mock API in dev** — `USE_MOCK = import.meta.env.DEV` flag in `api.ts` enables local development without ORDS
4. **Timezone handling** — defaults to browser timezone, user can override via dropdown, persisted in localStorage
5. **APEX Workflows as documentation** — workflow scripts are documented PL/SQL since APEX Workflows don't have a public creation API; they're configured via APEX Builder UI

## Build & Run

```bash
# Frontend development (with mock data)
cd frontend
npm install
npm run dev       # → http://localhost:5173/

# Frontend production build
npm run build     # → frontend/dist/

# Type check only
npx tsc --noEmit
```

## Testing with SQLcl MCP

Use the `jit_schema` connection to run SQL against the database:
- Run DDL scripts to create/alter tables
- Compile PL/SQL packages
- Execute ORDS module definitions
- Query data

## IDCS Group Naming Conventions

| Pattern | Purpose |
|---------|---------|
| `jit_<name>` | Base group (user must be member to see target) |
| `jit_<name>_approvers` | Approvers for this group target |
| `jit_<name>_elevated` | Elevated group users get added to |
| `inf_idcsuser_<name>` | Base group for password target |
| `inf_idcsuser_<name>_approvers` | Approvers for password target |
| `inf_idcsuser_<name>_elevated` | Elevated group for password target |

## Event Status Lifecycle

### Group Break-Glass
`started → approval_pending → approved → active → revoked → audit_captured`

Terminal states: `denied`, `expired`, `revocation_failed`, `audit_capture_failed`, `error`

### Password Break-Glass
`started → approval_pending → approved → password_revealed → password_reset → audit_captured`

Terminal states: `denied`, `expired`, `audit_capture_failed`, `error`
