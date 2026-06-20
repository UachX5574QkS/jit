import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

interface TimezoneContextValue {
  timezone: string;
  setTimezone: (tz: string) => void;
  formatDateTime: (iso: string) => string;
}

const STORAGE_KEY = 'jit-preferred-timezone';

function getInitialTimezone(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && Intl.supportedValuesOf('timeZone').includes(stored)) {
      return stored;
    }
  } catch {
    // localStorage unavailable or Intl not supported
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const TimezoneContext = createContext<TimezoneContextValue | undefined>(undefined);

export function useTimezone(): TimezoneContextValue {
  const context = useContext(TimezoneContext);
  if (context === undefined) {
    throw new Error('useTimezone must be used within a TimezoneProvider');
  }
  return context;
}

interface TimezoneProviderProps {
  children: ReactNode;
}

export function TimezoneProvider({ children }: TimezoneProviderProps) {
  const [timezone, setTimezoneState] = useState<string>(getInitialTimezone);

  function setTimezone(tz: string) {
    setTimezoneState(tz);
    try {
      localStorage.setItem(STORAGE_KEY, tz);
    } catch {
      // Ignore storage errors
    }
  }

  function formatDateTime(iso: string): string {
    const date = new Date(iso);
    return date.toLocaleString(undefined, {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    });
  }

  const value: TimezoneContextValue = { timezone, setTimezone, formatDateTime };

  return (
    <TimezoneContext.Provider value={value}>
      {children}
    </TimezoneContext.Provider>
  );
}
