import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { omegaApi, type OmegaTeam, type OmegaUser } from '../api';

type TeamRosterDraft = Record<string, Set<string>>;
type TeamView = 'settings' | 'member-status';

function formatRole(role: OmegaUser['role']) {
  const labels: Record<OmegaUser['role'], string> = {
    super_admin: 'Master Admin',
    support_admin: 'Super Admin',
    client_admin: 'Sub Admin',
    client_agent: 'Employee',
  };

  return labels[role] ?? role;
}

export function OmegaTeams() {
  const queryClient = useQueryClient();
  const { data: clients = [], isLoading, error } = useQuery({
    queryKey: ['omega-clients'],
    queryFn: omegaApi.clients,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const { data: teams = [] } = useQuery({
    queryKey: ['omega-teams'],
    queryFn: omegaApi.teams,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const { data: users = [] } = useQuery({
    queryKey: ['omega-users'],
    queryFn: omegaApi.users,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const [teamSearch, setTeamSearch] = useState<Record<string, string>>({});
  const [rosterDraft, setRosterDraft] = useState<TeamRosterDraft>({});
  const [createForm, setCreateForm] = useState({ clientId: '', name: '', description: '' });
  const [editingTeam, setEditingTeam] = useState<OmegaTeam | null>(null);
  const [editForm, setEditForm] = useState({
    clientId: '',
    name: '',
    description: '',
    status: 'active' as OmegaTeam['status'],
  });
  const [activeView, setActiveView] = useState<TeamView>('settings');
  const [memberSearch, setMemberSearch] = useState('');

  const invalidateAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['omega-clients'] }),
      queryClient.invalidateQueries({ queryKey: ['omega-teams'] }),
      queryClient.invalidateQueries({ queryKey: ['omega-users'] }),
    ]);
  };

  const clientsById = useMemo(() => new Map(clients.map(client => [client.id, client])), [clients]);

  const createTeamMutation = useMutation({
    mutationFn: () =>
      omegaApi.createTeam({
        clientId: createForm.clientId,
        name: createForm.name.trim(),
        description: createForm.description.trim(),
        status: 'active',
      }),
    onSuccess: async () => {
      setCreateForm({ clientId: '', name: '', description: '' });
      await invalidateAll();
    },
  });

  const updateTeamMutation = useMutation({
    mutationFn: async () => {
      if (!editingTeam) throw new Error('Team not selected');
      return omegaApi.updateTeam(editingTeam.id, {
        clientId: editForm.clientId,
        name: editForm.name.trim(),
        description: editForm.description.trim(),
        status: editForm.status,
      });
    },
    onSuccess: async () => {
      setEditingTeam(null);
      await invalidateAll();
    },
  });

  const saveRosterMutation = useMutation({
    mutationFn: async ({ team }: { team: OmegaTeam }) => {
      const currentMembers = users.filter(user => user.teamId === team.id).map(user => user.id);
      const selectedMembers = [...(rosterDraft[team.id] ?? new Set(currentMembers))];
      const selectedSet = new Set(selectedMembers);
      const work: Array<Promise<unknown>> = [];

      users.forEach(user => {
        if (selectedSet.has(user.id) && user.teamId !== team.id) {
          work.push(omegaApi.updateUser(user.id, { clientId: team.clientId, teamId: team.id }));
        }

        if (!selectedSet.has(user.id) && user.teamId === team.id) {
          work.push(omegaApi.updateUser(user.id, { clientId: user.clientId ?? team.clientId, teamId: null }));
        }
      });

      await Promise.all(work);
    },
    onSuccess: async (_data, variables) => {
      setRosterDraft(prev => {
        const next = { ...prev };
        delete next[variables.team.id];
        return next;
      });
      await invalidateAll();
    },
  });

  const unassignMemberMutation = useMutation({
    mutationFn: ({ userId, clientId }: { userId: string; clientId?: string | null }) =>
      omegaApi.updateUser(userId, { clientId: clientId ?? null, teamId: null }),
    onSuccess: invalidateAll,
  });

  const updateDutyMutation = useMutation({
    mutationFn: ({ userId, isOnDuty }: { userId: string; isOnDuty: boolean }) =>
      omegaApi.updateUser(userId, { isOnDuty }),
    onSuccess: invalidateAll,
  });

  const membersByTeamId = useMemo(() => {
    const map = new Map<string, OmegaUser[]>();
    teams.forEach(team => {
      map.set(
        team.id,
        users.filter(user => user.teamId === team.id),
      );
    });
    return map;
  }, [teams, users]);

  const assignableUsers = useMemo(
    () => users.filter(user => user.role !== 'super_admin' && user.role !== 'support_admin'),
    [users],
  );

  const employeeMembers = useMemo(() => {
    const normalized = memberSearch.trim().toLowerCase();
    return users
      .filter(user => user.role === 'client_agent')
      .filter(user => {
        if (!normalized) return true;
        return [user.fullName, user.email, user.workspaceName ?? user.companyName ?? '', user.teamName ?? '']
          .join(' ')
          .toLowerCase()
          .includes(normalized);
      });
  }, [memberSearch, users]);

  if (isLoading) return <div className="omega-card">Loading teams...</div>;
  if (error) return <div className="omega-inline-error">{(error as Error).message}</div>;

  return (
    <div className="omega-page">
      <section className="omega-card omega-team-view-switcher">
        <div className="omega-card-header">
          <div>
            <h2>Teams</h2>
            <p>Split team management into setup and member duty control.</p>
          </div>
        </div>
        <div className="omega-team-tabs">
          <button
            className={`omega-team-tab ${activeView === 'settings' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveView('settings')}
          >
            Team settings
          </button>
          <button
            className={`omega-team-tab ${activeView === 'member-status' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveView('member-status')}
          >
            Member status
          </button>
        </div>
      </section>

      {activeView === 'settings' ? (
        <>
          <section className="omega-card omega-team-create-card">
            <div className="omega-card-header">
              <div>
                <h2>Team Management</h2>
                <p>Create teams under a workspace, then assign members into the correct team roster.</p>
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
                <span>Workspace</span>
                <select
                  value={createForm.clientId}
                  onChange={event => setCreateForm({ ...createForm, clientId: event.target.value })}
                >
                  <option value="">Select workspace</option>
                  {clients.map(client => (
                    <option key={client.id} value={client.id}>
                      {client.companyName}
                    </option>
                  ))}
                </select>
              </label>
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
                <button
                  className="omega-primary-button"
                  type="submit"
                  disabled={createTeamMutation.isPending || !createForm.clientId || !createForm.name.trim()}
                >
                  {createTeamMutation.isPending ? 'Creating...' : 'Create'}
                </button>
                <button
                  className="omega-ghost-button"
                  type="button"
                  onClick={() => setCreateForm({ clientId: '', name: '', description: '' })}
                >
                  Reset
                </button>
              </div>
            </form>
            {createTeamMutation.error && (
              <div className="omega-inline-error">{(createTeamMutation.error as Error).message}</div>
            )}
          </section>

          <section className="omega-card">
            <div className="omega-card-header">
              <div>
                <h2>Team Settings</h2>
                <p>
                  Current teams, linked workspaces, roster assignment, and quick edit controls. Total teams:{' '}
                  {teams.length}
                </p>
              </div>
            </div>

            <div className="omega-team-stack">
              {teams.map(team => {
                const members = membersByTeamId.get(team.id) ?? [];
                const search = teamSearch[team.id] ?? '';
                const currentDraft = rosterDraft[team.id] ?? new Set(members.map(user => user.id));
                const visibleUsers = assignableUsers.filter(user => {
                  const normalized = search.trim().toLowerCase();
                  if (!normalized) return true;
                  return [user.fullName, user.email, user.workspaceName ?? user.companyName ?? '', user.teamName ?? '']
                    .join(' ')
                    .toLowerCase()
                    .includes(normalized);
                });

                return (
                  <article key={team.id} className="omega-team-panel">
                    <div className="omega-card-header">
                      <div>
                        <h3>{team.name}</h3>
                        <p>{team.description || 'No description provided.'}</p>
                        <p>
                          Workspace: {team.workspaceName ?? clientsById.get(team.clientId)?.companyName ?? 'Unassigned'}
                        </p>
                        <p>Team members: {members.length}</p>
                      </div>
                      <div className="omega-stack-inline">
                        <button
                          className="omega-ghost-button"
                          type="button"
                          onClick={() => {
                            setEditingTeam(team);
                            setEditForm({
                              clientId: team.clientId,
                              name: team.name,
                              description: team.description ?? '',
                              status: team.status,
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
                          onChange={event => setTeamSearch(prev => ({ ...prev, [team.id]: event.target.value }))}
                          placeholder="Search user by name, email, workspace, or team"
                        />

                        <div className="omega-team-roster-items">
                          {visibleUsers.map(user => {
                            const isChecked = currentDraft.has(user.id);
                            const currentTeamName = user.teamName ?? 'No team';
                            const currentWorkspaceName = user.workspaceName ?? user.companyName ?? 'No workspace';

                            return (
                              <label key={user.id} className="omega-team-user-row">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={event =>
                                    setRosterDraft(prev => {
                                      const nextSet = new Set(prev[team.id] ?? members.map(member => member.id));
                                      if (event.target.checked) {
                                        nextSet.add(user.id);
                                      } else {
                                        nextSet.delete(user.id);
                                      }
                                      return { ...prev, [team.id]: nextSet };
                                    })
                                  }
                                />
                                <div>
                                  <strong>
                                    {user.fullName} ({user.email})
                                  </strong>
                                  <p>
                                    {formatRole(user.role)} • {currentWorkspaceName} • Currently in {currentTeamName}
                                  </p>
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
                          onClick={() => saveRosterMutation.mutate({ team })}
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
                          disabled={saveRosterMutation.isPending || unassignMemberMutation.isPending}
                          onClick={() =>
                            unassignMemberMutation.mutate({
                              userId: member.id,
                              clientId: member.clientId ?? team.clientId,
                            })
                          }
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
        </>
      ) : (
        <section className="omega-card">
          <div className="omega-card-header">
            <div>
              <h2>Member Status</h2>
              <p>Force an employee on duty or off duty when they forget to update their own status.</p>
            </div>
          </div>

          <div className="omega-member-status-toolbar">
            <input
              type="search"
              className="omega-team-search"
              value={memberSearch}
              onChange={event => setMemberSearch(event.target.value)}
              placeholder="Search name, email, workspace, or team"
            />
          </div>

          <div className="omega-member-status-table">
            <div className="omega-member-status-head">
              <span>Member</span>
              <span>Workspace</span>
              <span>Team</span>
              <span>On duty</span>
            </div>
            <div className="omega-member-status-body">
              {employeeMembers.map(member => (
                <div key={member.id} className="omega-member-status-row">
                  <div className="omega-member-status-member">
                    <strong>{member.fullName}</strong>
                    <p>{member.email}</p>
                  </div>
                  <span>{member.workspaceName ?? member.companyName ?? 'Unassigned'}</span>
                  <span>{member.teamName ?? 'Unassigned'}</span>
                  <label className="omega-duty-switch">
                    <input
                      type="checkbox"
                      checked={member.isOnDuty}
                      disabled={updateDutyMutation.isPending}
                      onChange={event =>
                        updateDutyMutation.mutate({ userId: member.id, isOnDuty: event.target.checked })
                      }
                    />
                    <span className="omega-duty-switch-track" />
                    <em>{member.isOnDuty ? 'On duty' : 'Off duty'}</em>
                  </label>
                </div>
              ))}
              {employeeMembers.length === 0 && <p className="omega-empty">No employees found for this filter.</p>}
            </div>
          </div>

          {updateDutyMutation.error && (
            <div className="omega-inline-error">{(updateDutyMutation.error as Error).message}</div>
          )}
        </section>
      )}

      {editingTeam && (
        <div className="omega-modal-backdrop" onClick={() => !updateTeamMutation.isPending && setEditingTeam(null)}>
          <div className="omega-modal omega-user-modal" onClick={event => event.stopPropagation()}>
            <div className="omega-card-header">
              <div>
                <h2>Edit Team</h2>
                <p>Update the team workspace, name, description, and status.</p>
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
                  <span>Workspace</span>
                  <select
                    value={editForm.clientId}
                    onChange={event => setEditForm({ ...editForm, clientId: event.target.value })}
                  >
                    {clients.map(client => (
                      <option key={client.id} value={client.id}>
                        {client.companyName}
                      </option>
                    ))}
                  </select>
                </label>
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
                    onChange={event => setEditForm({ ...editForm, status: event.target.value as OmegaTeam['status'] })}
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </label>
              </div>
              {updateTeamMutation.error && (
                <div className="omega-inline-error">{(updateTeamMutation.error as Error).message}</div>
              )}
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
