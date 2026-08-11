import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { omegaApi, type OmegaUser } from '../api';

type UserFormState = {
  fullName: string;
  email: string;
  password: string;
  role: OmegaUser['role'];
  status: OmegaUser['status'];
  clientId: string;
};

function buildUserForm(user: OmegaUser): UserFormState {
  return {
    fullName: user.fullName,
    email: user.email,
    password: '',
    role: user.role,
    status: user.status,
    clientId: user.clientId ?? '',
  };
}

function formatRole(role: OmegaUser['role']) {
  const roleLabels: Record<OmegaUser['role'], string> = {
    super_admin: 'Super Admin',
    support_admin: 'Admin',
    client_admin: 'Sub Admin',
    client_agent: 'Employee',
  };
  return roleLabels[role];
}

function formatDate(value?: string | null) {
  if (!value) return 'Never';
  return new Date(value).toLocaleString();
}

export function OmegaStaff() {
  const queryClient = useQueryClient();
  const actorRole = (localStorage.getItem('omega_user_role') as OmegaUser['role'] | null) ?? 'super_admin';
  const { data: users = [], isLoading, error } = useQuery({ queryKey: ['omega-users'], queryFn: omegaApi.users });
  const { data: clients = [] } = useQuery({ queryKey: ['omega-clients'], queryFn: omegaApi.clients });
  const visibleRolePills = useMemo(() => {
    if (actorRole === 'super_admin') {
      return ['super_admin', 'support_admin', 'client_admin', 'client_agent'] as OmegaUser['role'][];
    }
    if (actorRole === 'support_admin') {
      return ['support_admin', 'client_admin', 'client_agent'] as OmegaUser['role'][];
    }
    return ['client_admin', 'client_agent'] as OmegaUser['role'][];
  }, [actorRole]);
  const availableRoles = useMemo(() => {
    if (actorRole === 'super_admin') {
      return ['super_admin', 'support_admin', 'client_admin', 'client_agent'] as OmegaUser['role'][];
    }
    if (actorRole === 'support_admin') {
      return ['support_admin', 'client_admin', 'client_agent'] as OmegaUser['role'][];
    }
    return ['client_admin', 'client_agent'] as OmegaUser['role'][];
  }, [actorRole]);
  const canChooseClient = actorRole !== 'client_admin';

  const [createForm, setCreateForm] = useState({
    fullName: '',
    email: '',
    password: 'ChangeMe123!',
    role: (availableRoles.includes('client_agent') ? 'client_agent' : availableRoles[0]) as OmegaUser['role'],
    clientId: '',
  });
  const [selectedRole, setSelectedRole] = useState<'all' | OmegaUser['role']>('all');
  const [selectedStatus, setSelectedStatus] = useState<'all' | OmegaUser['status']>('active');
  const [searchTerm, setSearchTerm] = useState('');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<UserFormState | null>(null);

  const invalidateUsers = () => queryClient.invalidateQueries({ queryKey: ['omega-users'] });
  const invalidateClients = () => queryClient.invalidateQueries({ queryKey: ['omega-clients'] });

  const createMutation = useMutation({
    mutationFn: () => omegaApi.createUser({ ...createForm, clientId: createForm.clientId || null }),
    onSuccess: async () => {
      setCreateForm({ fullName: '', email: '', password: 'ChangeMe123!', role: 'client_agent', clientId: '' });
      setIsCreateModalOpen(false);
      await Promise.all([invalidateUsers(), invalidateClients()]);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) => omegaApi.updateUser(id, payload),
    onSuccess: async () => {
      setEditingUserId(null);
      setEditForm(null);
      await Promise.all([invalidateUsers(), invalidateClients()]);
    },
  });

  const visibleUsers = useMemo(() => {
    return users.filter(user => {
      if (actorRole === 'super_admin') {
        return true;
      }
      if (actorRole === 'support_admin') {
        return user.role !== 'super_admin';
      }
      if (actorRole === 'client_admin') {
        return user.role !== 'super_admin' && user.role !== 'support_admin';
      }
      return false;
    });
  }, [actorRole, users]);

  const roleStats = useMemo(() => {
    const counts: Record<OmegaUser['role'], number> = {
      super_admin: 0,
      support_admin: 0,
      client_admin: 0,
      client_agent: 0,
    };
    visibleUsers.forEach(user => {
      counts[user.role] += 1;
    });
    return counts;
  }, [visibleUsers]);

  const filteredUsers = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();

    return visibleUsers.filter(user => {
      if (selectedRole !== 'all' && user.role !== selectedRole) return false;
      if (selectedStatus !== 'all' && user.status !== selectedStatus) return false;
      if (!normalizedSearch) return true;

      const haystack = [user.fullName, user.email, user.companyName ?? '', formatRole(user.role)].join(' ').toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [searchTerm, selectedRole, selectedStatus, visibleUsers]);

  const canManageUser = (user: OmegaUser) => {
    if (actorRole === 'super_admin') {
      return true;
    }

    if (actorRole === 'support_admin') {
      return user.role !== 'super_admin';
    }

    if (actorRole === 'client_admin') {
      return user.role !== 'super_admin' && user.role !== 'support_admin';
    }

    return false;
  };

  if (isLoading) return <div className="omega-card">Loading users...</div>;
  if (error) return <div className="omega-inline-error">{(error as Error).message}</div>;

  return (
    <div className="omega-page">
      <section className="omega-card omega-user-management">
        <div className="omega-card-header">
          <div>
            <h2>User Management</h2>
            <p>Add users quickly, search them easily, and open full details in a popup editor.</p>
          </div>
        </div>

        <div className="omega-user-stats">
          <div className="omega-user-stat-pill">
            <span>Total users</span>
            <strong>{visibleUsers.length}</strong>
          </div>
          <button className={`omega-filter-pill${selectedRole === 'all' ? ' active' : ''}`} type="button" onClick={() => setSelectedRole('all')}>
            All roles {visibleUsers.length}
          </button>
          {visibleRolePills.includes('super_admin') && (
            <button className={`omega-filter-pill${selectedRole === 'super_admin' ? ' active' : ''}`} type="button" onClick={() => setSelectedRole('super_admin')}>
              Super Admin {roleStats.super_admin}
            </button>
          )}
          {visibleRolePills.includes('support_admin') && (
            <button className={`omega-filter-pill${selectedRole === 'support_admin' ? ' active' : ''}`} type="button" onClick={() => setSelectedRole('support_admin')}>
              Admin {roleStats.support_admin}
            </button>
          )}
          {visibleRolePills.includes('client_admin') && (
            <button className={`omega-filter-pill${selectedRole === 'client_admin' ? ' active' : ''}`} type="button" onClick={() => setSelectedRole('client_admin')}>
              Sub Admin {roleStats.client_admin}
            </button>
          )}
          {visibleRolePills.includes('client_agent') && (
            <button className={`omega-filter-pill${selectedRole === 'client_agent' ? ' active' : ''}`} type="button" onClick={() => setSelectedRole('client_agent')}>
              Employee {roleStats.client_agent}
            </button>
          )}
        </div>

        <div className="omega-user-toolbar">
          <button className="omega-primary-button" type="button" onClick={() => setIsCreateModalOpen(true)}>
            Add User
          </button>
          <select value={selectedStatus} onChange={event => setSelectedStatus(event.target.value as 'all' | OmegaUser['status'])}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <input
            type="search"
            value={searchTerm}
            onChange={event => setSearchTerm(event.target.value)}
            placeholder="Search users"
          />
        </div>

        <div className="omega-user-table">
          <div className="omega-user-table-head">
            <span>User</span>
            <span>Role</span>
            <span>Status</span>
            <span>Team</span>
            <span>Last Login</span>
            <span>Actions</span>
          </div>

          <div className="omega-user-table-body">
            {filteredUsers.map(user => (
              <div key={user.id} className="omega-user-row">
                <div className="omega-user-cell omega-user-main">
                  <strong>{user.fullName}</strong>
                  <p>{user.email}</p>
                  <p>{user.companyName ?? 'No team assigned yet'}</p>
                </div>
                <div className="omega-user-cell">
                  <span className="omega-user-role">{formatRole(user.role)}</span>
                </div>
                <div className="omega-user-cell">
                  <span className={`omega-badge ${user.status === 'active' ? 'success' : 'danger'}`}>
                    {user.status}
                  </span>
                </div>
                <div className="omega-user-cell">
                  <span>{user.companyName ?? 'Unassigned'}</span>
                </div>
                <div className="omega-user-cell">
                  <span>{formatDate(user.lastLoginAt)}</span>
                </div>
                <div className="omega-user-cell omega-user-actions">
                  {canManageUser(user) ? (
                    <button
                      className="omega-ghost-button"
                      type="button"
                      onClick={() => {
                        setEditingUserId(user.id);
                        setEditForm(buildUserForm(user));
                      }}
                    >
                      Edit
                    </button>
                  ) : (
                    <button className="omega-ghost-button" type="button" disabled>
                      Locked
                    </button>
                  )}
                </div>
              </div>
            ))}

            {filteredUsers.length === 0 && <p className="omega-empty">No users matched your filters.</p>}
          </div>
        </div>
      </section>

      {editingUserId && editForm && (
        <div
          className="omega-modal-backdrop"
          onClick={() => {
            if (updateMutation.isPending) return;
            setEditingUserId(null);
            setEditForm(null);
          }}
        >
          <div className="omega-modal omega-user-modal" onClick={event => event.stopPropagation()}>
            <div className="omega-card-header">
              <div>
                <h2>Edit User</h2>
                <p>Update user details, team scope, role, status, and password from one popup.</p>
              </div>
            </div>

            {editForm && (
              <form
                className="omega-form"
                onSubmit={event => {
                  event.preventDefault();
                  updateMutation.mutate({
                    id: editingUserId!,
                    payload: {
                      fullName: editForm.fullName,
                      email: editForm.email,
                      role: editForm.role,
                      status: editForm.status,
                      clientId: editForm.clientId || null,
                      ...(editForm.password ? { password: editForm.password } : {}),
                    },
                  });
                }}
              >
                <div className="omega-grid omega-form-grid">
                  <label>
                    <span>Full Name</span>
                    <input
                      value={editForm.fullName}
                      onChange={event => setEditForm({ ...editForm, fullName: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>Email</span>
                    <input
                      type="email"
                      value={editForm.email}
                      onChange={event => setEditForm({ ...editForm, email: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>Role</span>
                    <select
                      value={editForm.role}
                      onChange={event => setEditForm({ ...editForm, role: event.target.value as OmegaUser['role'] })}
                    >
                      {availableRoles.map(role => (
                        <option key={role} value={role}>
                          {formatRole(role)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Status</span>
                    <select
                      value={editForm.status}
                      onChange={event => setEditForm({ ...editForm, status: event.target.value as OmegaUser['status'] })}
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </label>
                  <label>
                    <span>Team / Client Scope</span>
                    <select
                      value={editForm.clientId}
                      disabled={!canChooseClient}
                      onChange={event => setEditForm({ ...editForm, clientId: event.target.value })}
                    >
                      <option value="">No team scope</option>
                      {clients.map(client => (
                        <option key={client.id} value={client.id}>
                          {client.companyName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Reset Password</span>
                    <input
                      type="password"
                      value={editForm.password}
                      onChange={event => setEditForm({ ...editForm, password: event.target.value })}
                      placeholder="Leave blank to keep current password"
                    />
                  </label>
                </div>
                {updateMutation.error && <div className="omega-inline-error">{(updateMutation.error as Error).message}</div>}
                <div className="omega-modal-actions">
                  <button className="omega-primary-button" type="submit" disabled={updateMutation.isPending}>
                    {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
                  </button>
                  <button
                    className="omega-ghost-button"
                    type="button"
                    disabled={updateMutation.isPending}
                    onClick={() => {
                      setEditingUserId(null);
                      setEditForm(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {isCreateModalOpen && (
        <div
          className="omega-modal-backdrop"
          onClick={() => {
            if (createMutation.isPending) return;
            setIsCreateModalOpen(false);
          }}
        >
          <div className="omega-modal omega-user-modal" onClick={event => event.stopPropagation()}>
            <div className="omega-card-header">
              <div>
                <h2>Add User</h2>
                <p>Create a user from this popup and optionally attach the user to a team/client right away.</p>
              </div>
            </div>

            <form
              className="omega-form"
              onSubmit={event => {
                event.preventDefault();
                createMutation.mutate();
              }}
            >
              <div className="omega-grid omega-form-grid">
                <label>
                  <span>Full Name</span>
                  <input
                    value={createForm.fullName}
                    onChange={event => setCreateForm({ ...createForm, fullName: event.target.value })}
                  />
                </label>
                <label>
                  <span>Email</span>
                  <input
                    type="email"
                    value={createForm.email}
                    onChange={event => setCreateForm({ ...createForm, email: event.target.value })}
                  />
                </label>
                <label>
                  <span>Password</span>
                  <input
                    type="password"
                    value={createForm.password}
                    onChange={event => setCreateForm({ ...createForm, password: event.target.value })}
                  />
                </label>
                <label>
                  <span>Role</span>
                    <select
                      value={createForm.role}
                      onChange={event => setCreateForm({ ...createForm, role: event.target.value as OmegaUser['role'] })}
                    >
                      {availableRoles.map(role => (
                        <option key={role} value={role}>
                          {formatRole(role)}
                        </option>
                      ))}
                    </select>
                </label>
                <label>
                  <span>Team / Client</span>
                  <select
                    value={createForm.clientId}
                    disabled={!canChooseClient}
                    onChange={event => setCreateForm({ ...createForm, clientId: event.target.value })}
                  >
                    <option value="">No team scope</option>
                    {clients.map(client => (
                      <option key={client.id} value={client.id}>
                        {client.companyName}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {createMutation.error && <div className="omega-inline-error">{(createMutation.error as Error).message}</div>}
              <div className="omega-modal-actions">
                <button className="omega-primary-button" type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Creating...' : 'Create User'}
                </button>
                <button
                  className="omega-ghost-button"
                  type="button"
                  disabled={createMutation.isPending}
                  onClick={() => setIsCreateModalOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
