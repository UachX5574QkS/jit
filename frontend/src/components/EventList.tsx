import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getEvents, ApiError } from '../services/api';
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

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * EventList displays the user's break-glass events sorted by creation date (newest first).
 * Auto-refreshes every 30 seconds.
 *
 * Validates: Requirements 12.1, 12.3, 12.4
 */
export function EventList() {
  const [events, setEvents] = useState<BreakGlassEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isInitialLoad = useRef(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchEvents() {
      // Only show loading spinner on initial load, not on refresh
      if (isInitialLoad.current) {
        setLoading(true);
      }
      setError(null);

      try {
        const response = await getEvents();
        if (!cancelled) {
          setEvents(response.items);
        }
      } catch (err) {
        if (!cancelled) {
          if (err instanceof ApiError) {
            setError(err.message);
          } else {
            setError('Failed to load requests. Please try again later.');
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          isInitialLoad.current = false;
        }
      }
    }

    fetchEvents();

    const interval = setInterval(fetchEvents, 30000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return <div role="status" aria-label="Loading requests">Loading requests...</div>;
  }

  if (error) {
    return <div role="alert" className="error">{error}</div>;
  }

  if (events.length === 0) {
    return <div className="event-list event-list--empty">No requests found</div>;
  }

  return (
    <div className="event-list">
      <table aria-label="Break-glass requests">
        <thead>
          <tr>
            <th>Type</th>
            <th>Target</th>
            <th>Status</th>
            <th>Start Time</th>
            <th>End Time</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.event_id}>
              <td>
                <span className="badge badge--type">{event.event_type}</span>
              </td>
              <td>{event.target_identifier}</td>
              <td>
                <span className={`badge badge--status badge--status-${getStatusColor(event.status)}`}>
                  {event.status.replace(/_/g, ' ')}
                </span>
              </td>
              <td>{formatDateTime(event.start_time)}</td>
              <td>{formatDateTime(event.end_time)}</td>
              <td>{formatDateTime(event.created_at)}</td>
              <td>
                <Link to={`/events/${event.event_id}`} className="btn btn--view">
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
