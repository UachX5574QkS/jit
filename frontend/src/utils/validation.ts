import type { EventType } from '../types/api';

const MAX_GROUP_DURATION_MS = 72 * 60 * 60 * 1000; // 72 hours in milliseconds

/**
 * Validates a time window for a break glass request.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateTimeWindow(
  start: Date,
  end: Date,
  now: Date,
  type: EventType
): string | null {
  if (start < now) {
    return 'Start time must not be in the past';
  }

  if (start >= end) {
    return 'Start time must be before end time';
  }

  if (type === 'GROUP') {
    const duration = end.getTime() - start.getTime();
    if (duration > MAX_GROUP_DURATION_MS) {
      return 'Duration must not exceed 72 hours for group requests';
    }
  }

  return null;
}

/**
 * Validates a ticket reference string.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateTicketReference(ref: string): string | null {
  const trimmed = ref.trim();

  if (trimmed.length === 0) {
    return 'Ticket reference is required';
  }

  if (trimmed.length > 100) {
    return 'Ticket reference must not exceed 100 characters';
  }

  return null;
}

/**
 * Validates a description string.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateDescription(desc: string): string | null {
  if (desc.length === 0) {
    return 'Description is required';
  }

  if (desc.length > 500) {
    return 'Description must not exceed 500 characters';
  }

  return null;
}
