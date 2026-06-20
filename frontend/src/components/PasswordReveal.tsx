import { useState, useEffect, useCallback } from 'react';
import { revealPassword, ApiError } from '../services/api';

interface PasswordRevealProps {
  eventId: number;
  status: string;
  startTime: string; // ISO8601
  endTime: string; // ISO8601
}

/**
 * PasswordReveal shows a "Show Password" button when the event is approved
 * and the current time is within the access window. On click it calls the
 * reveal API and displays the returned password.
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.5, 11.6
 */
export function PasswordReveal({ eventId, status, startTime, endTime }: PasswordRevealProps) {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkVisibility = useCallback(() => {
    const now = Date.now();
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    const statusAllowed = status === 'approved' || status === 'password_revealed';
    const inWindow = now >= start && now <= end;
    setVisible(statusAllowed && inWindow);
  }, [status, startTime, endTime]);

  useEffect(() => {
    checkVisibility();
    const interval = setInterval(checkVisibility, 1000);
    return () => clearInterval(interval);
  }, [checkVisibility]);

  async function handleReveal() {
    setLoading(true);
    setError(null);
    setPassword(null);

    try {
      const response = await revealPassword({ event_id: eventId });
      setPassword(response.password);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Could not reveal password');
      }
    } finally {
      setLoading(false);
    }
  }

  if (!visible) {
    return null;
  }

  return (
    <div className="password-reveal">
      <button
        className="btn btn--reveal"
        onClick={handleReveal}
        disabled={loading}
        aria-label="Show Password"
      >
        {loading ? 'Revealing...' : 'Show Password'}
      </button>

      {loading && <div role="status" aria-label="Revealing password">Loading...</div>}

      {password && (
        <div className="password-reveal__result" aria-live="polite">
          <code className="password-reveal__value">{password}</code>
          <p className="password-reveal__expiry">Expires in 15 minutes</p>
        </div>
      )}

      {error && (
        <div className="password-reveal__error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
