import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthProvider';
import { getTargets, ApiError } from '../services/api';
import type { GroupTarget, PasswordTarget } from '../types/api';

/**
 * TargetDiscovery component displays available break-glass targets.
 *
 * Shows two sections:
 * - Group Targets: groups the user can raise a break-glass request for
 * - Password Targets: password accounts the user can raise a break-glass request for
 *
 * Validates: Requirements 3.2, 3.4, 8.2, 8.4
 */
export function TargetDiscovery() {
  const { loading: authLoading, error: authError, groups } = useAuth();
  const navigate = useNavigate();

  const [groupTargets, setGroupTargets] = useState<GroupTarget[]>([]);
  const [passwordTargets, setPasswordTargets] = useState<PasswordTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || authError) {
      return;
    }

    let cancelled = false;

    async function fetchTargets() {
      setLoading(true);
      setError(null);
      try {
        const response = await getTargets();
        if (!cancelled) {
          setGroupTargets(response.group_targets);
          setPasswordTargets(response.password_targets);
        }
      } catch (err) {
        if (!cancelled) {
          if (err instanceof ApiError) {
            setError(err.message);
          } else {
            setError('Failed to load targets. Please try again later.');
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchTargets();

    return () => {
      cancelled = true;
    };
  }, [authLoading, authError, groups]);

  if (authLoading) {
    return <div role="status" aria-label="Authenticating">Loading authentication...</div>;
  }

  if (authError) {
    return <div role="alert" className="error">{authError}</div>;
  }

  if (loading) {
    return <div role="status" aria-label="Loading targets">Loading targets...</div>;
  }

  if (error) {
    return <div role="alert" className="error">{error}</div>;
  }

  return (
    <div className="target-discovery">
      <section aria-labelledby="group-targets-heading">
        <h2 id="group-targets-heading">Group Targets</h2>
        {groupTargets.length === 0 ? (
          <p>No group break-glass targets available</p>
        ) : (
          <ul>
            {groupTargets.map((target) => (
              <li key={target.group_name}>
                <span>{target.group_name}</span>
                <button
                  onClick={() => navigate(`/request/group/${target.group_name}`)}
                >
                  Raise Request
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="password-targets-heading">
        <h2 id="password-targets-heading">Password Targets</h2>
        {passwordTargets.length === 0 ? (
          <p>No password break-glass targets available</p>
        ) : (
          <ul>
            {passwordTargets.map((target) => (
              <li key={target.user_name}>
                <span>{target.user_name}</span>
                <button
                  onClick={() => navigate(`/request/password/${target.user_name}`)}
                >
                  Raise Request
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
