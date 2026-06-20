import { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { AuthResponse } from '../types/api';
import { getAuth, ApiError } from '../services/api';

interface AuthContextValue {
  groups: string[];
  username: string | null;
  loading: boolean;
  error: string | null;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [groups, setGroups] = useState<string[]>([]);
  const [username] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchAuth() {
      try {
        const response: AuthResponse = await getAuth();
        if (!cancelled) {
          setGroups(response.groups);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          if (err instanceof ApiError) {
            setError(err.message);
          } else if (err instanceof Error) {
            setError('Identity service is unavailable. Please try again later.');
          } else {
            setError('An unexpected error occurred during authentication.');
          }
          setLoading(false);
        }
      }
    }

    fetchAuth();

    return () => {
      cancelled = true;
    };
  }, []);

  const value: AuthContextValue = { groups, username, loading, error };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
