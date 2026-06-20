import { useState } from 'react';
import { createEvent, ApiError } from '../services/api';
import { validateTimeWindow, validateTicketReference, validateDescription } from '../utils/validation';
import { ApproverSelector } from './ApproverSelector';

interface PasswordRequestFormProps {
  targetName: string;
}

interface FieldErrors {
  startTime: string | null;
  endTime: string | null;
  ticketReference: string | null;
  description: string | null;
  approver: string | null;
  form: string | null;
}

const emptyErrors: FieldErrors = {
  startTime: null,
  endTime: null,
  ticketReference: null,
  description: null,
  approver: null,
  form: null,
};

export function PasswordRequestForm({ targetName }: PasswordRequestFormProps) {
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [ticketReference, setTicketReference] = useState('');
  const [description, setDescription] = useState('');
  const [approverUsername, setApproverUsername] = useState<string | null>(null);
  const [autoApprove, setAutoApprove] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>(emptyErrors);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  function validate(): FieldErrors {
    const now = new Date();
    const start = startTime ? new Date(startTime) : null;
    const end = endTime ? new Date(endTime) : null;

    const fieldErrors: FieldErrors = { ...emptyErrors };

    if (!start) {
      fieldErrors.startTime = 'Start time is required';
    } else if (!end) {
      fieldErrors.endTime = 'End time is required';
    } else {
      const timeError = validateTimeWindow(start, end, now, 'PASSWORD');
      if (timeError) {
        // Assign to the most relevant field
        if (timeError.toLowerCase().includes('start')) {
          fieldErrors.startTime = timeError;
        } else {
          fieldErrors.endTime = timeError;
        }
      }
    }

    if (!end && !fieldErrors.endTime) {
      fieldErrors.endTime = 'End time is required';
    }

    const ticketError = validateTicketReference(ticketReference);
    if (ticketError) {
      fieldErrors.ticketReference = ticketError;
    }

    const descError = validateDescription(description);
    if (descError) {
      fieldErrors.description = descError;
    }

    if (!autoApprove && !approverUsername) {
      fieldErrors.approver = 'An approver must be selected';
    }

    return fieldErrors;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors(emptyErrors);
    setSuccess(false);

    const fieldErrors = validate();
    const hasErrors = Object.values(fieldErrors).some((err) => err !== null);

    if (hasErrors) {
      setErrors(fieldErrors);
      return;
    }

    setSubmitting(true);

    try {
      await createEvent({
        event_type: 'PASSWORD',
        target_identifier: targetName,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        ticket_reference: ticketReference.trim(),
        description,
        approver_username: autoApprove ? null : approverUsername,
      });
      setSuccess(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors({ ...emptyErrors, form: err.message });
      } else {
        setErrors({ ...emptyErrors, form: 'An unexpected error occurred' });
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="password-request-form password-request-form--success">
        <p>Password break-glass request submitted successfully.</p>
      </div>
    );
  }

  return (
    <form className="password-request-form" onSubmit={handleSubmit} noValidate>
      <h2>Password Break-Glass Request</h2>
      <p>Target account: <strong>{targetName}</strong></p>

      {errors.form && (
        <div className="password-request-form__error" role="alert">
          {errors.form}
        </div>
      )}

      <div className="password-request-form__field">
        <label htmlFor="prf-start-time">Start Time</label>
        <input
          id="prf-start-time"
          type="datetime-local"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          aria-invalid={errors.startTime ? 'true' : undefined}
          aria-describedby={errors.startTime ? 'prf-start-time-error' : undefined}
        />
        {errors.startTime && (
          <span id="prf-start-time-error" className="password-request-form__field-error" role="alert">
            {errors.startTime}
          </span>
        )}
      </div>

      <div className="password-request-form__field">
        <label htmlFor="prf-end-time">End Time</label>
        <input
          id="prf-end-time"
          type="datetime-local"
          value={endTime}
          onChange={(e) => setEndTime(e.target.value)}
          aria-invalid={errors.endTime ? 'true' : undefined}
          aria-describedby={errors.endTime ? 'prf-end-time-error' : undefined}
        />
        {errors.endTime && (
          <span id="prf-end-time-error" className="password-request-form__field-error" role="alert">
            {errors.endTime}
          </span>
        )}
      </div>

      <div className="password-request-form__field">
        <label htmlFor="prf-ticket-reference">Ticket Reference</label>
        <input
          id="prf-ticket-reference"
          type="text"
          value={ticketReference}
          onChange={(e) => setTicketReference(e.target.value)}
          maxLength={100}
          aria-invalid={errors.ticketReference ? 'true' : undefined}
          aria-describedby={errors.ticketReference ? 'prf-ticket-reference-error' : undefined}
        />
        {errors.ticketReference && (
          <span id="prf-ticket-reference-error" className="password-request-form__field-error" role="alert">
            {errors.ticketReference}
          </span>
        )}
      </div>

      <div className="password-request-form__field">
        <label htmlFor="prf-description">Description</label>
        <textarea
          id="prf-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
          rows={4}
          aria-invalid={errors.description ? 'true' : undefined}
          aria-describedby={errors.description ? 'prf-description-error' : undefined}
        />
        {errors.description && (
          <span id="prf-description-error" className="password-request-form__field-error" role="alert">
            {errors.description}
          </span>
        )}
      </div>

      <div className="password-request-form__field">
        <label>Approver</label>
        <ApproverSelector
          type="password"
          name={targetName}
          value={approverUsername}
          onChange={setApproverUsername}
          onAutoApprove={() => setAutoApprove(true)}
        />
        {errors.approver && (
          <span className="password-request-form__field-error" role="alert">
            {errors.approver}
          </span>
        )}
      </div>

      <button type="submit" disabled={submitting}>
        {submitting ? 'Submitting…' : 'Submit Request'}
      </button>
    </form>
  );
}
