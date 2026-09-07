import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/index.js';
import {
  DbRequestDetailStore,
  RequestForbiddenError,
  RequestNotFoundError,
  type AuditEntryView,
  type DetailViewer,
  type RequestDetailStore,
  type RequestDetailView,
  type RequestFieldView,
  type RequestNoteView,
} from './requests-detail.store.js';

/**
 * `GET /api/requests/{id}` — request detail (design: "Requests (user side)" —
 * `GET /api/requests/{id}` — detail incl. audit (internal notes excluded for
 * non-support viewers) (R5.1); records `last_seen` (R5.2); R17.4).
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * Available to any authenticated user WHO MAY VIEW the request — the raiser, a
 * support member of the request's team, or a manager in the raiser's hierarchy.
 * The global {@link authenticate} middleware mounted ahead of the requests
 * router already rejects unauthenticated callers with 401, so `req.currentUser`
 * is always present. The fine-grained visibility check (raiser / support /
 * manager-of-raiser) lives in the store, which knows the request's team and the
 * raiser's hierarchy; a denial surfaces here as 403 FORBIDDEN and an unknown id
 * as 404 NOT_FOUND.
 *
 * ── Support viewer vs non-support viewer (R5.1, R17.4) ────────────────────────
 * Whether the current user is a SUPPORT viewer depends on the request's team,
 * which is only known once the request is loaded. To keep that decision correct
 * AND keep the store free of the identity shape, the route passes the current
 * user's id and their team-membership set ({@link CurrentUser.teamsMemberOf})
 * as the {@link DetailViewer}; the store tests membership against the request's
 * own `team_id` and excludes internal notes / internal-note audit entries for a
 * non-support viewer before assembling the response.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * The handler depends on the narrow {@link RequestDetailStore} so it unit-tests
 * with an in-memory fake (no database). Production wiring uses
 * {@link DbRequestDetailStore}.
 */

// ── Public JSON views (camelCase, ISO dates) ───────────────────────────────────

export interface RequestFieldJson {
  readonly taskFieldId: number;
  readonly dataPointId: number;
  readonly fieldOrder: number;
  readonly name: string;
  readonly dataType: string;
  readonly isMandatory: boolean;
  readonly description: string | null;
  readonly helpText: string | null;
  readonly options: string[] | null;
  readonly regexpPattern: string | null;
  readonly value: string | null;
}

export interface RequestNoteJson {
  readonly id: number;
  readonly authorId: number;
  readonly isInternal: boolean;
  readonly body: string;
  readonly createdAt: string;
}

export interface AuditEntryJson {
  readonly id: number;
  readonly entityType: string;
  readonly entityId: number;
  readonly fieldName: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly changedById: number;
  readonly changedAt: string;
}

export interface RequestDetailJson {
  readonly id: number;
  readonly taskReference: string;
  readonly taskVersionId: number;
  readonly taskId: number;
  readonly taskName: string;
  readonly versionNo: number;
  readonly title: string;
  readonly raisedById: number;
  readonly teamId: number;
  readonly assignedMemberId: number | null;
  readonly status: string;
  readonly jiraNumber: string | null;
  readonly estimatedStartDate: string | null;
  readonly actualStartDate: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly fields: RequestFieldJson[];
  readonly notes: RequestNoteJson[];
  readonly auditTrail: AuditEntryJson[];
}

function serializeField(f: RequestFieldView): RequestFieldJson {
  return {
    taskFieldId: f.taskFieldId,
    dataPointId: f.dataPointId,
    fieldOrder: f.fieldOrder,
    name: f.name,
    dataType: f.dataType,
    isMandatory: f.isMandatory,
    description: f.description,
    helpText: f.helpText,
    options: f.options,
    regexpPattern: f.regexpPattern,
    value: f.value,
  };
}

function serializeNote(n: RequestNoteView): RequestNoteJson {
  return {
    id: n.id,
    authorId: n.authorId,
    isInternal: n.isInternal,
    body: n.body,
    createdAt: n.createdAt,
  };
}

function serializeAudit(a: AuditEntryView): AuditEntryJson {
  return {
    id: a.id,
    entityType: a.entityType,
    entityId: a.entityId,
    fieldName: a.fieldName,
    oldValue: a.oldValue,
    newValue: a.newValue,
    changedById: a.changedById,
    changedAt: a.changedAt,
  };
}

/** Serialise a store {@link RequestDetailView} into its public JSON view. */
export function serializeRequestDetail(detail: RequestDetailView): RequestDetailJson {
  return {
    id: detail.id,
    taskReference: detail.taskReference,
    taskVersionId: detail.taskVersionId,
    taskId: detail.taskId,
    taskName: detail.taskName,
    versionNo: detail.versionNo,
    title: detail.title,
    raisedById: detail.raisedById,
    teamId: detail.teamId,
    assignedMemberId: detail.assignedMemberId,
    status: detail.status,
    jiraNumber: detail.jiraNumber,
    estimatedStartDate: detail.estimatedStartDate,
    actualStartDate: detail.actualStartDate,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    fields: detail.fields.map(serializeField),
    notes: detail.notes.map(serializeNote),
    auditTrail: detail.auditTrail.map(serializeAudit),
  };
}

// ── Param parsing ──────────────────────────────────────────────────────────────

/** Parse a positive-integer id from a value, or `null` when malformed. */
function toPositiveInt(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) {
      return n;
    }
  }
  return null;
}

/** Read the authenticated current user (authenticate guarantees it upstream). */
function currentUser(req: { currentUser?: CurrentUser }): CurrentUser {
  const user = req.currentUser;
  if (!user) {
    // Defensive: authenticate runs upstream, so this is unreachable.
    throw ApiError.of('FORBIDDEN', 'Authentication required', undefined, 401);
  }
  return user;
}

/** Build the {@link DetailViewer} the store consumes from the current user. */
function toViewer(user: CurrentUser): DetailViewer {
  return { userId: user.id, teamsMemberOf: user.teamsMemberOf };
}

/**
 * `GET /requests/:id` — return the request detail (R5.1, R5.2, R17.4). Records
 * the viewer's `last_seen`, excludes internal notes and internal-note audit
 * entries for a non-support viewer, and enforces the visibility check. The
 * store is injected for testability; production uses {@link DbRequestDetailStore}.
 */
export function makeGetRequestDetailHandler(store: RequestDetailStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const id = toPositiveInt((req.params as Record<string, unknown>)['id']);
      if (id === null) {
        throw errors.validationFailed('A valid request id is required.', { field: 'id' });
      }
      const viewer = toViewer(currentUser(req));
      try {
        const detail = await store.getDetail(id, viewer);
        res.status(200).json(serializeRequestDetail(detail));
      } catch (err) {
        if (err instanceof RequestNotFoundError) {
          throw ApiError.of('NOT_FOUND', 'Request not found.', { requestId: err.requestId });
        }
        if (err instanceof RequestForbiddenError) {
          throw errors.forbidden('You are not permitted to view this request.', {
            requestId: err.requestId,
          });
        }
        throw err;
      }
    })().catch(next);
  };
}

/**
 * Register the request-detail route on a router (mounted at `/api`). Attached
 * to the passed-in router so it shares the requests router's `/requests`
 * prefix. The store is injected for testability; production uses
 * {@link DbRequestDetailStore}.
 */
export function registerRequestDetailRoute(
  router: Router,
  store: RequestDetailStore,
): Router {
  router.get('/requests/:id', makeGetRequestDetailHandler(store));
  return router;
}

/** A standalone request-detail router (used by tests and for isolated wiring). */
export function createRequestDetailRouter(store: RequestDetailStore): Router {
  return registerRequestDetailRoute(Router(), store);
}
