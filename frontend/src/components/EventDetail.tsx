import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getEvents, ApiError } from '../services/api';
import { useTimezone } from '../context/TimezoneProvider';
import type { BreakGlassEvent, EventStatus } from '../types/api';

type StatusColor = 'green' | 'red' | 'amber';

function getStatusColor(status: EventStatus): StatusColor {
  switch (status) {
    case 'approved':
    case 'active':
    case 'revoked':
    case 'audit_captured':
    case 'password_reset':
      return 'green';
    case 'denied':
    case 'expired':
    case 'error':
    case 'revocation_failed':
    case 'audit_capture_failed':
      return 'red';
    case 'started':
    case 'approval_pending':
    case 'password_revealed':
      return 'amber';
  }
}

/**
 * EventDetail displays the full details of a single break-glass event.
 * Fetches the event by filtering the events list by event_id from the URL params.
 *
 * Validates: Requirements 12.2
 */
export function EventDetail() {
  const { eventId } = useParams<{ eventId: string }>();
  const { formatDateTime } = useTimezone();
  const [event, setEvent] = useState<BreakGlassEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchEvent() {
      setLoading(true);
      setError(null);

      try {
        const response = await getEvents();
        if (cancelled) return;

        const found = response.items.find(
          (e) => e.event_id === Number(eventId)
        );

        if (found) {
          setEvent(found);
        } else {
          setError('Event not found.');
        }
      } catch (err) {
        if (!cancelled) {
          if (err instanceof ApiError) {
            setError(err.message);
          } else {
            setError('Failed to load event details. Please try again later.');
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchEvent();

    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (loading) {
    return <div role="status" aria-label="Loading event details">Loading event details...</div>;
  }

  if (error) {
    return (
      <div className="event-detail">
        <div role="alert" className="error">{error}</div>
        <Link to="/events" className="btn btn--back">Back to requests</Link>
      </div>
    );
  }

  if (!event) {
    return null;
  }

  const isPasswordApproved =
    event.event_type === 'PASSWORD' && event.status === 'approved';

  return (
    <div className="event-detail">
      <div className="event-detail__header">
        <Link to="/events" className="btn btn--back">← Back to requests</Link>
        <h1>Event #{event.event_id}</h1>
      </div>

      <div className="event-detail__content">
        <dl className="event-detail__fields">
          <div className="event-detail__field">
            <dt>Type</dt>
            <dd>
              <span className="badge badge--type">{event.event_type}</span>
            </dd>
          </div>

          <div className="event-detail__field">
            <dt>Target</dt>
            <dd>{event.target_identifier}</dd>
          </div>

          <div className="event-detail__field">
            <dt>Status</dt>
            <dd>
              <span className={`badge badge--status badge--status-${getStatusColor(event.status)}`}>
                {event.status.replace(/_/g, ' ')}
              </span>
            </dd>
          </div>

          <div className="event-detail__field">
            <dt>Time Window</dt>
            <dd>
              {formatDateTime(event.start_time)} — {formatDateTime(event.end_time)}
            </dd>
          </div>

          <div className="event-detail__field">
            <dt>Ticket Reference</dt>
            <dd>{event.ticket_reference}</dd>
          </div>

          <div className="event-detail__field">
            <dt>Description</dt>
            <dd>{event.description}</dd>
          </div>

          <div className="event-detail__field">
            <dt>Approver</dt>
            <dd>{event.approver_username ?? 'Auto-approved'}</dd>
          </div>

          <div className="event-detail__field">
            <dt>Requesting User</dt>
            <dd>{event.requesting_user}</dd>
          </div>

          <div className="event-detail__field">
            <dt>Created</dt>
            <dd>{formatDateTime(event.created_at)}</dd>
          </div>

          <div className="event-detail__field">
            <dt>Updated</dt>
            <dd>{formatDateTime(event.updated_at)}</dd>
          </div>
        </dl>

        <div className="event-detail__actions">
          <button type="button" className="btn btn--status" disabled>
            Status Timeline
          </button>
        </div>

        {isPasswordApproved && (
          <div className="event-detail__password-reveal">
            {/* PasswordReveal component will be rendered here once implemented (task 14.4) */}
            <p className="event-detail__password-placeholder">
              Password reveal available — component pending implementation.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
