import { useState } from 'react';
import { actionApproval, ApiError } from '../services/api';
import type { ApprovalAction as ApprovalActionType, ApprovalActionResponse } from '../types/api';

interface ApprovalActionProps {
  eventId: number;
  eventType: string;
  targetIdentifier: string;
  requestingUser: string;
  startTime: string;
  endTime: string;
  ticketReference: string;
  description: string;
  status: string;
  onActionComplete?: () => void;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * ApprovalAction displays pending approval details and provides Approve/Deny buttons.
 *
 * Validates: Requirements 6.2, 6.3, 10.4, 10.5
 */
export function ApprovalAction({
  eventId,
  eventType,
  targetIdentifier,
  requestingUser,
  startTime,
  endTime,
  ticketReference,
  description,
  status,
  onActionComplete,
}: ApprovalActionProps) {
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ApprovalActionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionTaken, setActionTaken] = useState<ApprovalActionType | null>(null);

  const isPending = status === 'approval_pending';
  const showActions = isPending && !result;

  async function handleAction(action: ApprovalActionType) {
    setLoading(true);
    setError(null);

    try {
      const response = await actionApproval(eventId, {
        action,
        comment: comment.trim() || undefined,
      });
      setResult(response);
      setActionTaken(action);
      onActionComplete?.();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="approval-action">
      <div className="approval-action__details">
        <h3>Request Details</h3>
        <dl className="approval-action__detail-list">
          <dt>Requesting User</dt>
          <dd>{requestingUser}</dd>
          <dt>Event Type</dt>
          <dd>{eventType}</dd>
          <dt>Target</dt>
          <dd>{targetIdentifier}</dd>
          <dt>Time Window</dt>
          <dd>{formatDateTime(startTime)} – {formatDateTime(endTime)}</dd>
          <dt>Ticket Reference</dt>
          <dd>{ticketReference}</dd>
          <dt>Description</dt>
          <dd>{description}</dd>
        </dl>
      </div>

      {result && (
        <div
          role="status"
          className={`approval-action__result approval-action__result--${actionTaken === 'APPROVE' ? 'approved' : 'denied'}`}
        >
          {actionTaken === 'APPROVE' ? 'Request approved' : 'Request denied'}
        </div>
      )}

      {error && (
        <div role="alert" className="approval-action__error">
          {error}
        </div>
      )}

      {showActions && (
        <div className="approval-action__form">
          <div className="approval-action__comment">
            <label htmlFor={`approval-comment-${eventId}`}>Comment (optional)</label>
            <textarea
              id={`approval-comment-${eventId}`}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add an optional comment..."
              disabled={loading}
              rows={3}
            />
          </div>
          <div className="approval-action__buttons">
            <button
              type="button"
              className="btn btn--approve"
              onClick={() => handleAction('APPROVE')}
              disabled={loading}
              aria-label="Approve request"
            >
              {loading ? 'Processing...' : 'Approve'}
            </button>
            <button
              type="button"
              className="btn btn--deny"
              onClick={() => handleAction('DENY')}
              disabled={loading}
              aria-label="Deny request"
            >
              {loading ? 'Processing...' : 'Deny'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
