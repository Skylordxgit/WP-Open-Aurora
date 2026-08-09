import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { omegaApi, type OmegaClient, type OmegaUser } from '../api';

type TeamMeta = {
  description: string;
};

type TeamRosterDraft = Record<string, Set<string>>;

const TEAM_META_STORAGE_KEY = 'omega_team_meta';

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function loadTeamMeta(): Record<string, TeamMeta> {
  try {
    const raw = localStorage.getItem(TEAM_META_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, TeamMeta>;
  } catch {
    return {};
  }
}

function saveTeamMeta(meta: Record<string, TeamMeta>) {
  localStorage.setItem(TEAM_META_STORAGE_KEY, JSON.stringify(meta));
}

function formatRole(role: OmegaUser['role']) {
  return role
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function OmegaTeams() {
  const queryClient = useQueryClient();
  const { data: clients = [], isLoading, error } = useQuery({ queryKey: ['omega-clients'], queryFn: omegaApi.clients });
  const { data: users = [] } = useQuery({ queryKey: ['omega-users'], queryFn: omegaApi.users });

  const [teamMeta, setTeamMeta] = useState<Record<string, TeamMeta>>(() => loadTeamMeta());
  const [teamSearch, setTeamSearch] = useState<Record<string, string>>({});
  const [rosterDraft, setRosterDraft] = useState<TeamRosterDraft>({});
  const [createForm, setCreateForm] = useState({ name: '', description: '' });
  const [editingTeam, setEditingTeam] = useState<OmegaClient | null>(null);
  const [editForm, setEditForm] = useState({ name: '', description: '', status: 'active' as OmegaClient['status'] });

  const invalidateAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['omega-clients'] }),
      queryClient.invalidateQueries({ queryKey: ['omega-users'] }),
    ]);
  };

  const createTeamMutation = useMutation({
    mutationFn: async () => {
      const slug = slugify(createForm.name) || `team-${Date.now()}`;
      const team = await omegaApi.createClient({
        companyName: createForm.name,
        ownerName: `${createForm.name} Team`,
        email: `${slug}@team.local`,
        phone: 'N/A',
        status: 'active',
        monthlyMessageLimit: 0,
        whatsappAccountLimit: 1,
      });

      const nextMeta = {
        ...teamMeta,
        [team.id]: { description: createForm.description.trim() },
      };
      saveTeamMeta(nextMeta);
      setTeamMeta(nextMeta);
      return team;
    },
    onSuccess: async () => {
      setCreateForm({ name: '', description: '' });
      await invalidateAll();
    },
  });

  const updateTeamMutation = useMutation({
    mutationFn: async () => {
      if (!editingTeam) throw new Error('Team not selected');
      const updated = await omegaApi.updateClient(editingTeam.id, {
        companyName: editForm.name,
        status: editForm.status,
      });

      const nextMeta = {
        ...teamMeta,
        [editingTeam.id]: { description: editForm.description.trim() },
      };
      saveTeamMeta(nextMeta);
      setTeamMeta(nextMeta);
      return updated;
    },
    onSuccess: async () => {
      setEditingTeam(null);
      await invalidateAll();
    },
  });

  const assignUserMutation = useMutation({
    mutationFn: ({ userId, clientId }: { userId: string; clientId: string | null }) =>
      omegaApi.updateUser(userId, { clientId }),
    onSuccess: invalidateAll,
  });

  const saveRosterMutation = useMutation({
    mutationFn: async ({ clientId }: { clientId: string }) => {
      const currentMembers = users.filter(user => user.clientId === clientId).map(user => user.id);
      const selectedMembers = [...(rosterDraft[clientId] ?? new Set(currentMembers))];
      const selectedSet = new Set(selectedMembers);

      const work: Array<Promise<unknown>> = [];

      users.forEach(user => {
        if (selectedSet.has(user.id) && user.clientId !== clientId) {
          work.push(omegaApi.updateUser(user.id, { clientId }));
        }
        if (!selectedSet.has(user.id) && user.clientId === clientId) {
          work.push(omegaApi.updateUser(user.id, { clientId: null }));
        }
      });

      await Promise.all(work);
    },
    onSuccess: async (_data, variables) => {
      setRosterDraft(prev => {
        const next = { ...prev };
        delete next[variables.clientId];
        return next;
      });
      await invalidateAll();
    },
  });

  const usersByTeamId = useMemo(() => {
    const map = new Map<string, OmegaUser[]>();
    clients.forEach(client => {
      map.set(
        client.id,
        users.filter(user => user.clientId === client.id),
      );
    });
    return map;
  }, [clients, users]);

  const assignableUsers = useMemo(
    () => users.filter(user => user.role !== 'super_admin' && user.role !== 'support_admin'),
    [users],
  );

  if (isLoading) return <div className="omega-card">Loading teams...</div>;
  if (error) return <div className="omega-inline-error">{(error as Error).message}</div>;

  return (
    <div className="omega-page">
      <section className="omega-card omega-team-create-card">
        <div className="omega-card-header">
          <div>
            <h2>Team Management</h2>
            <p>Create teams, assign users to one team, and manage team rosters from a separate page.</p>
          </div>
        </div>

        <form
          className="omega-team-create-form"
          onSubmit={event => {
            event.preventDefault();
            createTeamMutation.mutate();
          }}
        >
          <label>
            <span>Team name</span>
            <input
              value={createForm.name}
              onChange={event => setCreateForm({ ...createForm, name: event.target.value })}
              placeholder="Operations"
            />
          </label>
          <label>
            <span>Description</span>
            <input
              value={createForm.description}
              onChange={event => setCreateForm({ ...createForm, description: event.target.value })}
              placeholder="Optional team description"
            />
          </label>
          <div className="omega-team-create-actions">
            <button className="omega-primary-button" type="submit" disabled={createTeamMutation.isPending || !createForm.name.trim()}>
              {createTeamMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button
              className="omega-ghost-button"
              type="button"
              onClick={() => setCreateForm({ name: '', description: '' })}
            >
              Reset
            </button>
          </div>
        </form>
        {createTeamMutation.error && <div className="omega-inline-error">{(createTeamMutation.error as Error).message}</div>}
      </section>

      <section className="omega-card">
        <div className="omega-card-header">
          <div>
            <h2>Teams</h2>
            <p>Current teams, roster assignment, and quick edit controls. Total teams: {clients.length}</p>
          </div>
        </div>

        <div className="omega-team-stack">
          {clients.map(client => {
            const members = usersByTeamId.get(client.id) ?? [];
            const search = teamSearch[client.id] ?? '';
            const currentDraft = rosterDraft[client.id] ?? new Set(members.map(user => user.id));
            const visibleUsers = assignableUsers.filter(user => {
              const normalized = search.trim().toLowerCase();
              if (!normalized) return true;
              return [user.fullName, user.email].join(' ').toLowerCase().includes(normalized);
            });

            return (
              <article key={client.id} className="omega-team-panel">
                <div className="omega-card-header">
                  <div>
                    <h3>{client.companyName}</h3>
                    <p>{teamMeta[client.id]?.description || 'No description provided.'}</p>
                    <p>Team members: {members.length}</p>
                  </div>
                  <div className="omega-stack-inline">
                    <button
                      className="omega-ghost-button"
                      type="button"
                      onClick={() => {
                        setEditingTeam(client);
                        setEditForm({
                          name: client.companyName,
                          description: teamMeta[client.id]?.description ?? '',
                          status: client.status,
                        });
                      }}
                    >
                      Edit
                    </button>
                  </div>
                </div>

                <div className="omega-team-roster-shell">
                  <div className="omega-team-roster-list">
                    <input
                      type="search"
                      className="omega-team-search"
                      value={search}
                      onChange={event => setTeamSearch(prev => ({ ...prev, [client.id]: event.target.value }))}
                      placeholder="Search user by name or email"
                    />

                    <div className="omega-team-roster-items">
                      {visibleUsers.map(user => {
                        const isChecked = currentDraft.has(user.id);
                        const currentTeamName = user.companyName ?? 'No team';

                        return (
                          <label key={user.id} className="omega-team-user-row">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={event =>
                                setRosterDraft(prev => {
                                  const nextSet = new Set(prev[client.id] ?? members.map(member => member.id));
                                  if (event.target.checked) {
                                    nextSet.add(user.id);
                                  } else {
                                    nextSet.delete(user.id);
                                  }
                                  return { ...prev, [client.id]: nextSet };
                                })
                              }
                            />
                            <div>
                              <strong>{user.fullName} ({user.email})</strong>
                              <p>{formatRole(user.role)} • Currently in {currentTeamName}</p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <div className="omega-team-roster-actions">
                    <button
                      className="omega-primary-button omega-team-save-button"
                      type="button"
                      disabled={saveRosterMutation.isPending}
                      onClick={() => saveRosterMutation.mutate({ clientId: client.id })}
                    >
                      {saveRosterMutation.isPending ? 'Saving...' : 'Save team roster'}
                    </button>
                  </div>
                </div>

                <div className="omega-team-chip-list">
                  {members.map(member => (
                    <button
                      key={member.id}
                      className="omega-team-chip"
                      type="button"
                      disabled={assignUserMutation.isPending}
                      onClick={() => assignUserMutation.mutate({ userId: member.id, clientId: null })}
                    >
                      {member.fullName} ({member.email}) • {formatRole(member.role)}
                    </button>
                  ))}
                  {members.length === 0 && <p className="omega-empty">No team members assigned yet.</p>}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {editingTeam && (
        <div className="omega-modal-backdrop" onClick={() => !updateTeamMutation.isPending && setEditingTeam(null)}>
          <div className="omega-modal omega-user-modal" onClick={event => event.stopPropagation()}>
            <div className="omega-card-header">
              <div>
                <h2>Edit Team</h2>
                <p>Update the team name, description, and status.</p>
              </div>
            </div>
            <form
              className="omega-form"
              onSubmit={event => {
                event.preventDefault();
                updateTeamMutation.mutate();
              }}
            >
              <div className="omega-grid omega-form-grid">
                <label>
                  <span>Team name</span>
                  <input
                    value={editForm.name}
                    onChange={event => setEditForm({ ...editForm, name: event.target.value })}
                  />
                </label>
                <label>
                  <span>Description</span>
                  <input
                    value={editForm.description}
                    onChange={event => setEditForm({ ...editForm, description: event.target.value })}
                  />
                </label>
                <label>
                  <span>Status</span>
                  <select
                    value={editForm.status}
                    onChange={event => setEditForm({ ...editForm, status: event.target.value as OmegaClient['status'] })}
                  >
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </label>
              </div>
              {updateTeamMutation.error && <div className="omega-inline-error">{(updateTeamMutation.error as Error).message}</div>}
              <div className="omega-modal-actions">
                <button className="omega-primary-button" type="submit" disabled={updateTeamMutation.isPending}>
                  {updateTeamMutation.isPending ? 'Saving...' : 'Save Team'}
                </button>
                <button className="omega-ghost-button" type="button" onClick={() => setEditingTeam(null)}>
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
