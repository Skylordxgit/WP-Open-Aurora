import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { omegaApi } from '../api';

export function OmegaClients() {
  const { data, isLoading, error } = useQuery({ queryKey: ['omega-clients'], queryFn: omegaApi.clients });

  if (isLoading) return <div className="omega-card">Loading clients...</div>;
  if (error) return <div className="omega-inline-error">{(error as Error).message}</div>;

  return (
    <div className="omega-page">
      <div className="omega-page-actions">
        <div>
          <h2>Clients</h2>
          <p>Create and manage SaaS tenants without exposing the OpenWA technical console.</p>
        </div>
        <Link className="omega-primary-button" to="/clients/new">
          Add Client
        </Link>
      </div>

      <section className="omega-card">
        <div className="omega-table">
          <div className="omega-table-head omega-table-head-clients">
            <span>Company</span>
            <span>Plan</span>
            <span>Usage</span>
            <span>Sessions</span>
            <span>Status</span>
            <span>Actions</span>
          </div>
          {data!.map(client => (
            <div key={client.id} className="omega-table-row omega-table-head-clients">
              <div>
                <strong>{client.companyName}</strong>
                <p>{client.ownerName}</p>
              </div>
              <span>{client.planName ?? 'Custom'}</span>
              <span>
                {(client.usageThisMonth ?? 0).toLocaleString()} / {client.monthlyMessageLimit.toLocaleString()}
              </span>
              <span>
                {client.connectedSessions ?? 0} / {client.whatsappAccountLimit}
              </span>
              <span className={`omega-badge ${client.status === 'active' ? 'success' : 'danger'}`}>{client.status}</span>
              <div className="omega-table-actions">
                <Link to={`/clients/${client.id}`}>Details</Link>
                <Link to={`/clients/${client.id}/edit`}>Edit</Link>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
