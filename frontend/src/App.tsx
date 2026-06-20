import { HashRouter, Routes, Route, Link, useParams } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthProvider';
import { TargetDiscovery } from './components/TargetDiscovery';
import { EventList } from './components/EventList';
import { EventDetail } from './components/EventDetail';
import { AdminTenancyManager } from './components/AdminTenancyManager';
import { ApprovalAction } from './components/ApprovalAction';
import { GroupRequestForm } from './components/GroupRequestForm';
import { PasswordRequestForm } from './components/PasswordRequestForm';
import { getEvents, ApiError } from './services/api';
import type { BreakGlassEvent } from './types/api';
import './App.css';

/**
 * Wrapper page for the /approvals/:eventId route.
 * Fetches the event by ID and passes its data as props to ApprovalAction.
 */
function ApprovalPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [event, setEvent] = useState<BreakGlassEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchEvent() {
      try {
        const response = await getEvents();
        const found = response.items.find(
          (e) => e.event_id === Number(eventId)
        );
        if (!cancelled) {
          if (found) {
            setEvent(found);
          } else {
            setError('Event not found.');
          }
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? err.message
              : 'Failed to load event details.'
          );
          setLoading(false);
        }
      }
    }

    fetchEvent();
    return () => { cancelled = true; };
  }, [eventId]);

  if (loading) return <p>Loading event…</p>;
  if (error) return <p className="error-message">{error}</p>;
  if (!event) return <p className="error-message">Event not found.</p>;

  return (
    <ApprovalAction
      eventId={event.event_id}
      eventType={event.event_type}
      targetIdentifier={event.target_identifier}
      requestingUser={event.requesting_user}
      startTime={event.start_time}
      endTime={event.end_time}
      ticketReference={event.ticket_reference}
      description={event.description}
      status={event.status}
    />
  );
}

/** Wrapper for /request/group/:name route */
function GroupRequestPage() {
  const { name } = useParams<{ name: string }>();
  if (!name) return <p className="error-message">Target name is required.</p>;
  return <GroupRequestForm targetName={decodeURIComponent(name)} />;
}

/** Wrapper for /request/password/:name route */
function PasswordRequestPage() {
  const { name } = useParams<{ name: string }>();
  if (!name) return <p className="error-message">Target name is required.</p>;
  return <PasswordRequestForm targetName={decodeURIComponent(name)} />;
}

/** Navigation header */
function NavHeader() {
  return (
    <nav className="app-nav" aria-label="Main navigation">
      <Link to="/" className="nav-brand">JIT Break Glass</Link>
      <ul className="nav-links">
        <li><Link to="/">Home</Link></li>
        <li><Link to="/events">My Requests</Link></li>
        <li><Link to="/admin">Admin</Link></li>
      </ul>
    </nav>
  );
}

/** Auth-gated app shell that blocks usage on auth error */
function AppShell() {
  const { loading, error } = useAuth();

  if (loading) {
    return (
      <div className="app-loading">
        <p>Authenticating…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app-error" role="alert">
        <h1>Authentication Error</h1>
        <p>{error}</p>
        <p>Please contact your administrator or try again later.</p>
      </div>
    );
  }

  return (
    <>
      <NavHeader />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<TargetDiscovery />} />
          <Route path="/events" element={<EventList />} />
          <Route path="/events/:eventId" element={<EventDetail />} />
          <Route path="/admin" element={<AdminTenancyManager />} />
          <Route path="/approvals/:eventId" element={<ApprovalPage />} />
          <Route path="/request/group/:name" element={<GroupRequestPage />} />
          <Route path="/request/password/:name" element={<PasswordRequestPage />} />
        </Routes>
      </main>
    </>
  );
}

function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </HashRouter>
  );
}

export default App;
