import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { omegaApi } from '../api';
import { useToast } from '../../components/Toast';

export function OmegaClientDetails() {
  const { id = '' } = useParams();
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({ queryKey: ['omega-client', id], queryFn: () => omegaApi.client(id) });
  const { data: sessions = [] } = useQuery({
    queryKey: ['omega-client-sessions', id],
    queryFn: () => omegaApi.clientSessions(id),
  });
  const { data: usage } = useQuery({ queryKey: ['omega-client-usage', id], queryFn: () => omegaApi.clientUsage(id) });
  const { data: allSessions = [] } = useQuery({
    queryKey: ['omega-workspace-session-pool', id],
    queryFn: () => omegaApi.sessions(),
  });

  const refreshWorkspaceQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['omega-client', id] }),
      queryClient.invalidateQueries({ queryKey: ['omega-client-sessions', id] }),
      queryClient.invalidateQueries({ queryKey: ['omega-client-usage', id] }),
      queryClient.invalidateQueries({ queryKey: ['omega-workspace-session-pool', id] }),
      queryClient.invalidateQueries({ queryKey: ['omega-sessions'] }),
      queryClient.invalidateQueries({ queryKey: ['omega-clients'] }),
    ]);
  };

  const assignSessionMutation = useMutation({
    mutationFn: (sessionId: string) => omegaApi.assignSession(sessionId, { clientId: id }),
    onSuccess: async () => {
      await refreshWorkspaceQueries();
      toast.success('Session attached', 'This device now belongs to this workspace only.');
    },
    onError: mutationError => {
      toast.error('Unable to attach session', mutationError instanceof Error ? mutationError.message : 'Please try again.');
    },
  });

  const unassignSessionMutation = useMutation({
    mutationFn: (sessionId: string) => omegaApi.unassignSession(sessionId),
    onSuccess: async () => {
      await refreshWorkspaceQueries();
      toast.success('Session removed', 'This device has been detached from the workspace.');
    },
    onError: mutationError => {
      toast.error('Unable to remove session', mutationError instanceof Error ? mutationError.message : 'Please try again.');
    },
  });

  if (isLoading) return <div className="omega-card">Loading workspace details...</div>;
  if (error) return <div className="omega-inline-error">{(error as Error).message}</div>;

  const workspaceSessions = sessions;
  const attachableSessions = allSessions.filter(session => !session.clientId || session.clientId === id);

  return (
    <div className="omega-page">
      <div className="omega-page-actions">
        <div>
          <h2>{data!.companyName}</h2>
          <p>
            {data!.ownerName} • {data!.email} • {data!.phone}
          </p>
        </div>
        <div className="omega-stack-inline">
          <span className={`omega-badge ${data!.status === 'active' ? 'success' : 'danger'}`}>{data!.status}</span>
          <Link className="omega-primary-button" to={`/clients/${data!.id}/edit`}>
            Edit Workspace
          </Link>
        </div>
      </div>

      <section className="omega-grid omega-grid-two">
        <article className="omega-card">
          <h3>Workspace Limits</h3>
          <dl className="omega-definition-list">
            <div>
              <dt>Message Limit</dt>
              <dd>{data!.monthlyMessageLimit.toLocaleString()}</dd>
            </div>
            <div>
              <dt>WhatsApp Limit</dt>
              <dd>{data!.whatsappAccountLimit}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{data!.status}</dd>
            </div>
          </dl>
        </article>
        <article className="omega-card">
          <h3>Foundation Metrics</h3>
          <dl className="omega-definition-list">
            <div>
              <dt>Contacts</dt>
              <dd>{data!.contactsCount}</dd>
            </div>
            <div>
              <dt>Contact Groups</dt>
              <dd>{data!.contactGroupsCount}</dd>
            </div>
            <div>
              <dt>Assigned Sessions</dt>
              <dd>{workspaceSessions.length}</dd>
            </div>
            <div>
              <dt>Workspace Staff</dt>
              <dd>{data!.staff.length}</dd>
            </div>
          </dl>
        </article>
      </section>

      <section className="omega-grid omega-grid-two">
        <article className="omega-card">
          <div className="omega-card-header">
            <div>
              <h3>Workspace Sessions</h3>
              <p>Only these devices work inside this workspace and its teams.</p>
            </div>
          </div>
          <div className="omega-list">
            {workspaceSessions.map(session => (
              <div key={session.id} className="omega-list-item">
                <div>
                  <strong>{session.openwaSessionName ?? session.openwaSessionId}</strong>
                  <p>
                    {session.phoneNumber ?? 'No phone'}
                    {session.lastSeenAt ? ` • ${new Date(session.lastSeenAt).toLocaleString()}` : ''}
                  </p>
                </div>
                <div className="omega-table-actions">
                  <span
                    className={`omega-badge ${
                      session.status === 'connected' ? 'success' : session.status === 'needs_reconnect' ? 'warning' : 'neutral'
                    }`}
                  >
                    {session.status}
                  </span>
                  <button
                    className="omega-ghost-button"
                    type="button"
                    disabled={unassignSessionMutation.isPending}
                    onClick={() => void unassignSessionMutation.mutateAsync(session.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            {workspaceSessions.length === 0 ? (
              <div className="omega-list-item">
                <div>
                  <strong>No sessions attached yet</strong>
                  <p>Attach a device below to make it available only to this workspace.</p>
                </div>
              </div>
            ) : null}
          </div>
        </article>

        <article className="omega-card">
          <div className="omega-card-header">
            <div>
              <h3>Workspace Staff</h3>
              <p>Users scoped to this workspace and ready for team-based chat access.</p>
            </div>
          </div>
          <div className="omega-list">
            {data!.staff.map(user => (
              <div key={user.id} className="omega-list-item">
                <div>
                  <strong>{user.fullName}</strong>
                  <p>{user.email}</p>
                </div>
                <span className="omega-badge neutral">{user.role}</span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="omega-card">
        <div className="omega-card-header">
          <div>
            <h3>{data!.companyName} Session Section</h3>
            <p>Attach only the sessions that should belong to this workspace. Other workspaces will not use them.</p>
          </div>
        </div>
        <div className="omega-list">
          {attachableSessions.map(session => {
            const attachedHere = session.clientId === id;
            return (
              <div key={session.id} className="omega-list-item">
                <div>
                  <strong>{session.openwaSessionName ?? session.openwaSessionId}</strong>
                  <p>
                    {session.phoneNumber ?? 'No phone'}
                    {session.companyName ? ` • ${session.companyName}` : ' • Unassigned'}
                  </p>
                </div>
                <div className="omega-table-actions">
                  <span
                    className={`omega-badge ${
                      session.status === 'connected' ? 'success' : session.status === 'needs_reconnect' ? 'warning' : 'neutral'
                    }`}
                  >
                    {session.status}
                  </span>
                  {attachedHere ? (
                    <span className="omega-badge neutral">Attached</span>
                  ) : (
                    <button
                      className="omega-primary-button"
                      type="button"
                      disabled={assignSessionMutation.isPending}
                      onClick={() => void assignSessionMutation.mutateAsync(session.id)}
                    >
                      Attach to workspace
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {attachableSessions.length === 0 ? (
            <div className="omega-list-item">
              <div>
                <strong>No available sessions</strong>
                <p>Create or reconnect a device first, then attach it here.</p>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="omega-card">
        <div className="omega-card-header">
          <div>
            <h3>Recent Usage & Messages</h3>
            <p>Live usage foundation based on the sessions assigned to this workspace.</p>
          </div>
        </div>
        <div className="omega-grid omega-grid-two">
          <div className="omega-chart">
            {(usage?.trend ?? data!.usageSummary).map(point => (
              <div key={point.month} className="omega-chart-row">
                <span>{point.month}</span>
                <div className="omega-chart-bar-wrap">
                  <div className="omega-chart-bar" style={{ width: `${Math.max(12, point.messages / 1200)}%` }} />
                </div>
                <strong>{point.messages.toLocaleString()}</strong>
              </div>
            ))}
          </div>
          <div className="omega-list">
            {usage && (
              <>
                <div className="omega-list-item">
                  <div>
                    <strong>Messages Today</strong>
                    <p>Current-day outbound traffic</p>
                  </div>
                  <span className="omega-badge neutral">{usage.messagesToday.toLocaleString()}</span>
                </div>
                <div className="omega-list-item">
                  <div>
                    <strong>Messages This Month</strong>
                    <p>
                      {usage.messagesThisMonth.toLocaleString()} / {usage.monthlyMessageLimit.toLocaleString()} plan limit
                    </p>
                  </div>
                  <span className="omega-badge neutral">{usage.sessionCount} sessions tracked</span>
                </div>
              </>
            )}
            {data!.recentMessages.map(message => (
              <div key={message.id} className="omega-list-item">
                <div>
                  <strong>{message.recipient}</strong>
                  <p>{message.body}</p>
                </div>
                <span className="omega-badge neutral">{message.status}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
