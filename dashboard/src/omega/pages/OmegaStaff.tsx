import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { omegaApi } from '../api';

export function OmegaStaff() {
  const queryClient = useQueryClient();
  const { data: users = [], isLoading, error } = useQuery({ queryKey: ['omega-users'], queryFn: omegaApi.users });
  const { data: clients = [] } = useQuery({ queryKey: ['omega-clients'], queryFn: omegaApi.clients });
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    password: 'ChangeMe123!',
    role: 'support_admin',
    clientId: '',
  });

  const mutation = useMutation({
    mutationFn: () => omegaApi.createUser({ ...form, clientId: form.clientId || null }),
    onSuccess: () => {
      setForm({ fullName: '', email: '', password: 'ChangeMe123!', role: 'support_admin', clientId: '' });
      void queryClient.invalidateQueries({ queryKey: ['omega-users'] });
    },
  });

  if (isLoading) return <div className="omega-card">Loading admin users...</div>;
  if (error) return <div className="omega-inline-error">{(error as Error).message}</div>;

  return (
    <div className="omega-page">
      <section className="omega-grid omega-grid-two">
        <article className="omega-card">
          <div className="omega-card-header">
            <div>
              <h2>Admin Users / Staff</h2>
              <p>Super admins and support admins for the Omega operational team, plus seeded client-side roles for later phases.</p>
            </div>
          </div>
          <div className="omega-list">
            {users.map(user => (
              <div key={user.id} className="omega-list-item">
                <div>
                  <strong>{user.fullName}</strong>
                  <p>{user.email}{user.companyName ? ` • ${user.companyName}` : ''}</p>
                </div>
                <span className={`omega-badge ${user.status === 'suspended' ? 'danger' : 'neutral'}`}>{user.role}</span>
              </div>
            ))}
          </div>
        </article>

        <article className="omega-card">
          <h2>Add Admin / Staff User</h2>
          <form
            className="omega-form"
            onSubmit={event => {
              event.preventDefault();
              mutation.mutate();
            }}
          >
            <label><span>Full Name</span><input value={form.fullName} onChange={event => setForm({ ...form, fullName: event.target.value })} /></label>
            <label><span>Email</span><input type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} /></label>
            <label><span>Password</span><input type="password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} /></label>
            <label>
              <span>Role</span>
              <select value={form.role} onChange={event => setForm({ ...form, role: event.target.value })}>
                <option value="super_admin">super_admin</option>
                <option value="support_admin">support_admin</option>
                <option value="client_admin">client_admin</option>
                <option value="client_agent">client_agent</option>
              </select>
            </label>
            <label>
              <span>Client Scope (optional)</span>
              <select value={form.clientId} onChange={event => setForm({ ...form, clientId: event.target.value })}>
                <option value="">No client scope</option>
                {clients.map(client => (
                  <option key={client.id} value={client.id}>
                    {client.companyName}
                  </option>
                ))}
              </select>
            </label>
            {mutation.error && <div className="omega-inline-error">{(mutation.error as Error).message}</div>}
            <button className="omega-primary-button" type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Creating...' : 'Create User'}
            </button>
          </form>
        </article>
      </section>
    </div>
  );
}
