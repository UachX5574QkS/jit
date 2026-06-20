import { useState, useEffect } from 'react';
import { getApprovers } from '../services/api';
import type { Approver } from '../types/api';

interface ApproverSelectorProps {
  type: 'group' | 'password';
  name: string;
  value: string | null;
  onChange: (username: string | null) => void;
  onAutoApprove: () => void;
}

export function ApproverSelector({
  type,
  name,
  value,
  onChange,
  onAutoApprove,
}: ApproverSelectorProps) {
  const [approvers, setApprovers] = useState<Approver[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchApprovers() {
      setLoading(true);
      setError(null);

      try {
        const response = await getApprovers(type, name);
        if (cancelled) return;

        const list = response.approvers;
        setApprovers(list);

        if (list.length === 0) {
          onAutoApprove();
        }
      } catch {
        if (!cancelled) {
          setError('Could not load approvers');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchApprovers();

    return () => {
      cancelled = true;
    };
  }, [type, name]);

  if (loading) {
    return <div className="approver-selector approver-selector--loading">Loading approvers…</div>;
  }

  if (error) {
    return <div className="approver-selector approver-selector--error">{error}</div>;
  }

  if (approvers.length === 0) {
    return (
      <div className="approver-selector approver-selector--auto-approve">
        No approvers available - request will be auto-approved
      </div>
    );
  }

  return (
    <div className="approver-selector">
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        required
        aria-label="Select an approver"
      >
        <option value="" disabled>
          Select an approver
        </option>
        {approvers.map((approver) => (
          <option key={approver.username} value={approver.username}>
            {approver.display_name} ({approver.email})
          </option>
        ))}
      </select>
    </div>
  );
}
