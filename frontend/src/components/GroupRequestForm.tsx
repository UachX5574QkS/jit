import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApproverSelector } from './ApproverSelector';
import { createEvent, ApiError } from '../services/api';
import { validateTimeWindow, validateTicketReference, validateDescription } from '../utils/validation';

interface GroupRequestFormProps {
  targetName: string;
}

interface FormValues {
  startTime: string;
  endTime: string;
  ticketReference: string;
  description: string;
  approverUsername: string | null;
}

interface FormErrors {
  startTime: string | null;
  endTime: string | null;
  ticketReference: string | null;
  description: string | null;
  approver: string | null;
}

/**
 * GroupRequestForm renders a form to create a GROUP break-glass event.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2
 */
export function GroupRequestForm({ targetName }: GroupRequestFormProps) {
  const [values, setValues] = useState<FormValues>({
    startTime: '',
    endTime: '',
    ticketReference: '',
    description: '',
    approverUsername: null,
  });

  const [errors, setErrors] = useState<FormErrors>({
    startTime: null,
    endTime: null,
    ticketReference: null,
    description: null,
    approver: null,
  });

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [autoApprove, setAutoApprove] = useState(false);

  function handleAutoApprove() {
    setAutoApprove(true);
    setValues((prev) => ({ ...prev, approverUsername: null }));
  }

  function validate(): boolean {
    const now = new Date();
    const start = values.startTime ? new Date(values.startTime) : null;
    const end = values.endTime ? new Date(values.endTime) : null;

    const newErrors: FormErrors = {
      startTime: null,
      endTime: null,
      ticketReference: null,
      description: null,
      approver: null,
    };

    if (!start) {
      newErrors.startTime = 'Start time is required';
    }

    if (!end) {
      newErrors.endTime = 'End time is required';
    }

    if (start && end) {
      const timeError = validateTimeWindow(start, end, now, 'GROUP');
      if (timeError) {
        // Assign time window errors to the most relevant field
        if (timeError.toLowerCase().includes('start')) {
          newErrors.startTime = timeError;
        } else {
          newErrors.endTime = timeError;
        }
      }
    }

    newErrors.ticketReference = validateTicketReference(values.ticketReference);
    newErrors.description = validateDescription(values.description);

    if (!autoApprove && !values.approverUsername) {
      newErrors.approver = 'An approver must be selected';
    }

    setErrors(newErrors);

    return !Object.values(newErrors).some((e) => e !== null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    if (!validate()) {
      return;
    }

    setSubmitting(true);

    try {
      await createEvent({
        event_type: 'GROUP',
        target_identifier: targetName,
        start_time: new Date(values.startTime).toISOString(),
        end_time: new Date(values.endTime).toISOString(),
        ticket_reference: values.ticketReference.trim(),
        description: values.description,
        approver_username: values.approverUsername,
      });
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else {
        setSubmitError('An unexpected error occurred. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="group-request-form group-request-form--success" role="status">
        <p>Break-glass request for group &quot;{targetName}&quot; submitted successfully.</p>
      </div>
    );
  }

  return (
    <form className="group-request-form" onSubmit={handleSubmit} noValidate>
      <h2>Group Break-Glass Request: {targetName}</h2>

      <div className="form-field">
        <label htmlFor="start-time">Start Time</label>
        <input
          id="start-time"
          type="datetime-local"
          value={values.startTime}
          onChange={(e) => setValues((prev) => ({ ...prev, startTime: e.target.value }))}
          aria-invalid={errors.startTime ? true : undefined}
          aria-describedby={errors.startTime ? 'start-time-error' : undefined}
        />
        {errors.startTime && (
          <span id="start-time-error" className="field-error" role="alert">
            {errors.startTime}
          </span>
        )}
      </div>

      <div className="form-field">
        <label htmlFor="end-time">End Time</label>
        <input
          id="end-time"
          type="datetime-local"
          value={values.endTime}
          onChange={(e) => setValues((prev) => ({ ...prev, endTime: e.target.value }))}
          aria-invalid={errors.endTime ? true : undefined}
          aria-describedby={errors.endTime ? 'end-time-error' : undefined}
        />
        {errors.endTime && (
          <span id="end-time-error" className="field-error" role="alert">
            {errors.endTime}
          </span>
        )}
      </div>

      <div className="form-field">
        <label htmlFor="ticket-reference">Ticket Reference</label>
        <input
          id="ticket-reference"
          type="text"
          maxLength={100}
          value={values.ticketReference}
          onChange={(e) => setValues((prev) => ({ ...prev, ticketReference: e.target.value }))}
          aria-invalid={errors.ticketReference ? true : undefined}
          aria-describedby={errors.ticketReference ? 'ticket-reference-error' : undefined}
        />
        {errors.ticketReference && (
          <span id="ticket-reference-error" className="field-error" role="alert">
            {errors.ticketReference}
          </span>
        )}
      </div>

      <div className="form-field">
        <label htmlFor="description">Description</label>
        <textarea
          id="description"
          maxLength={500}
          value={values.description}
          onChange={(e) => setValues((prev) => ({ ...prev, description: e.target.value }))}
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={errors.description ? 'description-error' : undefined}
        />
        {errors.description && (
          <span id="description-error" className="field-error" role="alert">
            {errors.description}
          </span>
        )}
      </div>

      <div className="form-field">
        <label>Approver</label>
        <ApproverSelector
          type="group"
          name={targetName}
          value={values.approverUsername}
          onChange={(username) => setValues((prev) => ({ ...prev, approverUsername: username }))}
          onAutoApprove={handleAutoApprove}
        />
        {errors.approver && (
          <span className="field-error" role="alert">
            {errors.approver}
          </span>
        )}
      </div>

      {submitError && (
        <div className="form-error" role="alert">
          {submitError}
        </div>
      )}

      <button type="submit" disabled={submitting}>
        {submitting ? 'Submitting…' : 'Submit Request'}
      </button>
    </form>
  );
}
