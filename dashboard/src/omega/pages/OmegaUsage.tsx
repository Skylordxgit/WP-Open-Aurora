import { useQuery } from '@tanstack/react-query';
import { omegaApi } from '../api';

export function OmegaUsage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['omega-usage'], queryFn: omegaApi.usage });

  if (isLoading) return <div className="omega-card">Loading usage overview...</div>;
  if (error) return <div className="omega-inline-error">{(error as Error).message}</div>;

  return (
    <div className="omega-page">
      <div className="omega-page-actions">
        <div>
          <h2>Usage / Limits</h2>
          <p>Read-only SaaS usage visibility inside the main OpenWA admin dashboard.</p>
        </div>
        {data!.fallbackUsed && <span className="omega-badge warning">Fallback data</span>}
      </div>

      <section className="omega-grid omega-grid-stats">
        <article className="omega-stat-card">
          <span>Messages Today</span>
          <strong>{data!.totals.messagesToday.toLocaleString()}</strong>
        </article>
        <article className="omega-stat-card">
          <span>Messages This Month</span>
          <strong>{data!.totals.messagesThisMonth.toLocaleString()}</strong>
        </article>
        <article className="omega-stat-card">
          <span>Reconnect Events</span>
          <strong>{data!.totals.reconnections.toLocaleString()}</strong>
        </article>
        <article className="omega-stat-card">
          <span>Tracked Clients</span>
          <strong>{data!.perClient.length.toLocaleString()}</strong>
        </article>
      </section>

      <section className="omega-card">
        <div className="omega-card-header">
          <div>
            <h2>Client Limits</h2>
            <p>Monthly usage and WhatsApp account allocation per SaaS tenant.</p>
          </div>
        </div>

        {data!.perClient.length === 0 ? (
          <p className="omega-empty">No client usage data is available yet.</p>
        ) : (
          <div className="omega-list">
            {data!.perClient.map(client => (
              <div key={client.clientId} className="omega-list-item">
                <div>
                  <strong>{client.companyName}</strong>
                  <p>
                    {client.messagesThisMonth.toLocaleString()} / {client.monthlyMessageLimit.toLocaleString()} monthly
                    messages
                  </p>
                </div>
                <div className="omega-stack-inline">
                  <span className={`omega-badge ${client.status === 'active' ? 'success' : 'danger'}`}>
                    {client.status}
                  </span>
                  <span className="omega-badge neutral">
                    {client.sessionCount} / {client.whatsappAccountLimit} WhatsApp accounts
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
