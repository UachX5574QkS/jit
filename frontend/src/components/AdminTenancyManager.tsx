import { useState, useEffect } from 'react';
import { getTenancies, createTenancy, updateTenancy, deleteTenancy, ApiError } from '../services/api';
import type { IdcsTenancy, CreateTenancyRequest } from '../types/api';

type ViewMode = 'list' | 'create' | 'edit';

const emptyForm: CreateTenancyRequest = {
  tenancy_identifier: '',
  stripe_url: '',
  client_id: '',
  client_secret: '',
};

/**
 * AdminTenancyManager provides full CRUD operations for IDCS tenancy records.
 * Administrators can list, create, edit, and delete tenancy configurations.
 *
 * Validates: Requirements 2.1, 2.2, 2.3
 */
export function AdminTenancyManager() {
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [tenancies, setTenancies] = useState<IdcsTenancy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<CreateTenancyRequest>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editingTenancy, setEditingTenancy] = useState<IdcsTenancy | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IdcsTenancy | null>(null);

  async function fetchTenancies() {
    setLoading(true);
    setError(null);
    try {
      const response = await getTenancies();
      setTenancies(response.items);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to load tenancies. Please try again later.');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchTenancies();
  }, []);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  }

  function validateForm(): string | null {
    if (!formData.tenancy_identifier.trim()) return 'Tenancy identifier is required.';
    if (!formData.stripe_url.trim()) return 'Stripe URL is required.';
    if (!formData.client_id.trim()) return 'Client ID is required.';
    if (!formData.client_secret.trim()) return 'Client secret is required.';
    return null;
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const validationError = validateForm();
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setSubmitting(true);
    try {
      await createTenancy(formData);
      setFormData(emptyForm);
      setViewMode('list');
      await fetchTenancies();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setFormError('A tenancy with this identifier already exists.');
      } else if (err instanceof ApiError) {
        setFormError(err.message);
      } else {
        setFormError('Failed to create tenancy. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (!editingTenancy) return;
    setFormError(null);

    const validationError = validateForm();
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setSubmitting(true);
    try {
      await updateTenancy(editingTenancy.tenancy_id, formData);
      setFormData(emptyForm);
      setEditingTenancy(null);
      setViewMode('list');
      await fetchTenancies();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setFormError('A tenancy with this identifier already exists.');
      } else if (err instanceof ApiError) {
        setFormError(err.message);
      } else {
        setFormError('Failed to update tenancy. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setError(null);
    try {
      await deleteTenancy(deleteTarget.tenancy_id);
      setDeleteTarget(null);
      await fetchTenancies();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to delete tenancy. Please try again.');
      }
      setDeleteTarget(null);
    }
  }

  function startEdit(tenancy: IdcsTenancy) {
    setEditingTenancy(tenancy);
    setFormData({
      tenancy_identifier: tenancy.tenancy_identifier,
      stripe_url: tenancy.stripe_url,
      client_id: tenancy.client_id,
      client_secret: tenancy.client_secret ?? '',
    });
    setFormError(null);
    setViewMode('edit');
  }

  function startCreate() {
    setFormData(emptyForm);
    setFormError(null);
    setViewMode('create');
  }

  function cancelForm() {
    setFormData(emptyForm);
    setFormError(null);
    setEditingTenancy(null);
    setViewMode('list');
  }

  // Delete confirmation dialog
  if (deleteTarget) {
    return (
      <div className="admin-tenancy-manager">
        <div className="delete-confirmation" role="alertdialog" aria-labelledby="delete-title">
          <h3 id="delete-title">Confirm Delete</h3>
          <p>
            Are you sure you want to delete tenancy{' '}
            <strong>{deleteTarget.tenancy_identifier}</strong>? This action cannot be undone.
          </p>
          <div className="button-group">
            <button className="btn btn--danger" onClick={handleDelete}>
              Delete
            </button>
            <button className="btn btn--secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Create / Edit form
  if (viewMode === 'create' || viewMode === 'edit') {
    return (
      <div className="admin-tenancy-manager">
        <h2>{viewMode === 'create' ? 'Add New Tenancy' : 'Edit Tenancy'}</h2>
        {formError && (
          <div role="alert" className="error">
            {formError}
          </div>
        )}
        <form onSubmit={viewMode === 'create' ? handleCreate : handleUpdate}>
          <div className="form-field">
            <label htmlFor="tenancy_identifier">Tenancy Identifier</label>
            <input
              id="tenancy_identifier"
              name="tenancy_identifier"
              type="text"
              value={formData.tenancy_identifier}
              onChange={handleInputChange}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="stripe_url">Stripe URL</label>
            <input
              id="stripe_url"
              name="stripe_url"
              type="text"
              value={formData.stripe_url}
              onChange={handleInputChange}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="client_id">Client ID</label>
            <input
              id="client_id"
              name="client_id"
              type="text"
              value={formData.client_id}
              onChange={handleInputChange}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="client_secret">Client Secret</label>
            <input
              id="client_secret"
              name="client_secret"
              type="password"
              value={formData.client_secret}
              onChange={handleInputChange}
              required
            />
          </div>
          <div className="button-group">
            <button type="submit" className="btn btn--primary" disabled={submitting}>
              {submitting ? 'Saving...' : viewMode === 'create' ? 'Create' : 'Update'}
            </button>
            <button type="button" className="btn btn--secondary" onClick={cancelForm}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    );
  }

  // List view
  if (loading) {
    return (
      <div className="admin-tenancy-manager" role="status" aria-label="Loading tenancies">
        Loading tenancies...
      </div>
    );
  }

  if (error) {
    return (
      <div className="admin-tenancy-manager">
        <div role="alert" className="error">{error}</div>
      </div>
    );
  }

  return (
    <div className="admin-tenancy-manager">
      <div className="header-row">
        <h2>IDCS Tenancies</h2>
        <button className="btn btn--primary" onClick={startCreate}>
          Add New Tenancy
        </button>
      </div>
      {tenancies.length === 0 ? (
        <p>No tenancies configured.</p>
      ) : (
        <table aria-label="IDCS tenancy records">
          <thead>
            <tr>
              <th>Tenancy Identifier</th>
              <th>Stripe URL</th>
              <th>Client ID</th>
              <th>Created At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tenancies.map((tenancy) => (
              <tr key={tenancy.tenancy_id}>
                <td>{tenancy.tenancy_identifier}</td>
                <td>{tenancy.stripe_url}</td>
                <td>{tenancy.client_id}</td>
                <td>{new Date(tenancy.created_at).toLocaleString()}</td>
                <td>
                  <button className="btn btn--edit" onClick={() => startEdit(tenancy)}>
                    Edit
                  </button>
                  <button className="btn btn--danger" onClick={() => setDeleteTarget(tenancy)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
