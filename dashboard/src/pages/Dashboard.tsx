import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  CalendarRange,
  CheckCircle2,
  Clock3,
  Loader2,
  MessageSquareText,
  RefreshCcw,
  Users,
} from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { PageHeader } from '../components/PageHeader';
import {
  omegaApi,
  type OmegaAnalyticsPreset,
  type OmegaDashboardSummary,
  type OmegaEmployeeAnalytics,
} from '../omega/api';
import './Dashboard.css';

function formatDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatDuration(ms: number | null) {
  if (ms === null || ms < 0) {
    return '—';
  }

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function formatRole(role: string) {
  const labels: Record<string, string> = {
    super_admin: 'Master Admin',
    support_admin: 'Super Admin',
    client_admin: 'Sub Admin',
    client_agent: 'Employee',
  };

  return labels[role] ?? role.replace(/_/g, ' ');
}

function getPresetLabel(preset: OmegaAnalyticsPreset) {
  if (preset === 'day') return 'Today';
  if (preset === 'week') return 'This week';
  if (preset === 'month') return 'This month';
  return 'Custom range';
}

export function Dashboard() {
  useDocumentTitle('Dashboard');

  const [dashboard, setDashboard] = useState<OmegaDashboardSummary | null>(null);
  const [analytics, setAnalytics] = useState<OmegaEmployeeAnalytics | null>(null);
  const [preset, setPreset] = useState<OmegaAnalyticsPreset>('week');
  const [customStartDate, setCustomStartDate] = useState(() => {
    const start = new Date();
    start.setDate(start.getDate() - 6);
    return formatDateInput(start);
  });
  const [customEndDate, setCustomEndDate] = useState(() => formatDateInput(new Date()));
  const [draftStartDate, setDraftStartDate] = useState(() => {
    const start = new Date();
    start.setDate(start.getDate() - 6);
    return formatDateInput(start);
  });
  const [draftEndDate, setDraftEndDate] = useState(() => formatDateInput(new Date()));
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const hasLoadedOnceRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const loadDashboard = async () => {
      if (preset === 'custom' && (!customStartDate || !customEndDate)) {
        return;
      }

      setError('');
      if (hasLoadedOnceRef.current) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }

      try {
        const [dashboardSummary, employeeAnalytics] = await Promise.all([
          omegaApi.dashboard(),
          omegaApi.employeeAnalytics({
            preset,
            ...(preset === 'custom' ? { startDate: customStartDate, endDate: customEndDate } : {}),
          }),
        ]);

        if (cancelled) {
          return;
        }

        setDashboard(dashboardSummary);
        setAnalytics(employeeAnalytics);
        hasLoadedOnceRef.current = true;
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load dashboard');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    };

    void loadDashboard();

    return () => {
      cancelled = true;
    };
  }, [preset, customStartDate, customEndDate, refreshKey]);

  const statsCards = [
    {
      label: 'Active sessions',
      value: dashboard?.stats.connectedSessions ?? 0,
      helper: `${dashboard?.stats.totalSessions ?? 0} total connected workspaces`,
      icon: Activity,
    },
    {
      label: 'Messages today',
      value: dashboard?.stats.messagesToday ?? 0,
      helper: `${dashboard?.stats.messagesThisMonth ?? 0} this month`,
      icon: MessageSquareText,
    },
    {
      label: 'Active employees',
      value: analytics?.summary.activeEmployees ?? 0,
      helper: `${analytics?.employees.length ?? 0} scoped team members`,
      icon: Users,
    },
    {
      label: 'Handled chats',
      value: analytics?.summary.handledChats ?? 0,
      helper: `${analytics?.summary.assignedChats ?? 0} assigned in range`,
      icon: CheckCircle2,
    },
    {
      label: 'First response',
      value: formatDuration(analytics?.summary.firstResponseAvgMs ?? null),
      helper: 'Average first reply time',
      icon: Clock3,
    },
    {
      label: 'Avg response',
      value: formatDuration(analytics?.summary.avgResponseMs ?? null),
      helper: `${analytics?.summary.closedChats ?? 0} chats closed in range`,
      icon: CalendarRange,
    },
  ];

  if (isLoading) {
    return (
      <div className="dashboard dashboard-loading">
        <Loader2 className="dashboard-spinner" size={32} />
      </div>
    );
  }

  return (
    <div className="dashboard dashboard-omega">
      <PageHeader
        title="Dashboard"
        subtitle="Track employee chat workload, response speed, assignments, and closures across your Aurora workspace."
        badge={
          <span
            className={`status-badge ${(dashboard?.stats.connectedSessions ?? 0) > 0 ? 'connected' : 'disconnected'}`}
          >
            {(dashboard?.stats.connectedSessions ?? 0) > 0 ? 'Live operations' : 'Disconnected'}
          </span>
        }
        actions={
          <div className="dashboard-controls">
            <div className="dashboard-preset-group">
              {(['day', 'week', 'month', 'custom'] as OmegaAnalyticsPreset[]).map(option => (
                <button
                  key={option}
                  type="button"
                  className={`dashboard-preset-button ${preset === option ? 'active' : ''}`}
                  onClick={() => setPreset(option)}
                >
                  {getPresetLabel(option)}
                </button>
              ))}
            </div>
            {preset === 'custom' && (
              <div className="dashboard-date-range">
                <input type="date" value={draftStartDate} onChange={event => setDraftStartDate(event.target.value)} />
                <input type="date" value={draftEndDate} onChange={event => setDraftEndDate(event.target.value)} />
                <button
                  type="button"
                  className="dashboard-apply-button"
                  onClick={() => {
                    setCustomStartDate(draftStartDate);
                    setCustomEndDate(draftEndDate);
                  }}
                  disabled={!draftStartDate || !draftEndDate || isRefreshing}
                >
                  Apply
                </button>
              </div>
            )}
            <button
              type="button"
              className="dashboard-refresh-button"
              onClick={() => setRefreshKey(current => current + 1)}
              disabled={isRefreshing}
            >
              <RefreshCcw size={16} className={isRefreshing ? 'spin' : ''} />
              Refresh
            </button>
          </div>
        }
      />

      {error ? <div className="dashboard-error">{error}</div> : null}

      <div className="dashboard-range-summary">
        <div className="dashboard-range-copy">
          <span>{analytics ? `${getPresetLabel(analytics.range.preset)} view` : 'Range view'}</span>
          <strong>
            {analytics?.range.startDate ?? '—'} to {analytics?.range.endDate ?? '—'}
          </strong>
        </div>
        <div className="dashboard-range-editor">
          <input
            type="date"
            value={draftStartDate}
            onChange={event => {
              setPreset('custom');
              setDraftStartDate(event.target.value);
            }}
          />
          <span className="dashboard-range-separator">to</span>
          <input
            type="date"
            value={draftEndDate}
            onChange={event => {
              setPreset('custom');
              setDraftEndDate(event.target.value);
            }}
          />
          <button
            type="button"
            className="dashboard-apply-button"
            onClick={() => {
              setPreset('custom');
              setCustomStartDate(draftStartDate);
              setCustomEndDate(draftEndDate);
            }}
            disabled={!draftStartDate || !draftEndDate || isRefreshing}
          >
            Use custom range
          </button>
        </div>
      </div>

      <div className="stats-grid dashboard-stats-grid">
        {statsCards.map(({ label, value, helper, icon: Icon }) => (
          <article key={label} className="stat-card dashboard-stat-card">
            <div className="stat-header">
              <span className="stat-label">{label}</span>
              <Icon size={18} className="stat-icon" />
            </div>
            <div className="stat-value">{typeof value === 'number' ? value.toLocaleString() : value}</div>
            <p className="dashboard-stat-helper">{helper}</p>
          </article>
        ))}
      </div>

      <section className="dashboard-table-section">
        <div className="section-header">
          <div>
            <h2>Employee performance</h2>
            <p className="section-subtitle">
              Daily, weekly, monthly, or custom-range chat handling performance for each scoped employee.
            </p>
          </div>
        </div>

        <div className="dashboard-table">
          <div className="dashboard-table-head">
            <span>Employee</span>
            <span>Role</span>
            <span>Workspace</span>
            <span>Handled</span>
            <span>Assigned</span>
            <span>Closed</span>
            <span>Open now</span>
            <span>First response</span>
            <span>Avg response</span>
          </div>
          {analytics && analytics.employees.length > 0 ? (
            analytics.employees.map(employee => (
              <div key={employee.userId} className="dashboard-table-row">
                <div className="dashboard-employee-cell">
                  <strong>{employee.fullName}</strong>
                  <span>{employee.email}</span>
                </div>
                <span>{formatRole(employee.role)}</span>
                <span>{employee.companyName ?? 'Unassigned'}</span>
                <span>{employee.handledChats}</span>
                <span>{employee.assignedChats}</span>
                <span>{employee.closedChats}</span>
                <span>{employee.activeChats}</span>
                <span>{formatDuration(employee.firstResponseAvgMs)}</span>
                <span>{formatDuration(employee.avgResponseMs)}</span>
              </div>
            ))
          ) : (
            <div className="dashboard-empty-state">
              Employee analytics will appear here as soon as chats are assigned and agents begin replying.
            </div>
          )}
        </div>
      </section>

      <div className="dashboard-secondary-grid">
        <section className="dashboard-panel">
          <div className="section-header">
            <div>
              <h2>Top workspaces</h2>
              <p className="section-subtitle">Highest message volume in the current Aurora scope.</p>
            </div>
          </div>
          <div className="dashboard-list">
            {dashboard && dashboard.topClients.length > 0 ? (
              dashboard.topClients.map(client => (
                <div key={client.clientId} className="dashboard-list-row">
                  <div>
                    <strong>{client.companyName}</strong>
                    <span>Workspace traffic</span>
                  </div>
                  <strong>{client.units.toLocaleString()}</strong>
                </div>
              ))
            ) : (
              <div className="dashboard-empty-state compact">No workspace traffic yet.</div>
            )}
          </div>
        </section>

        <section className="dashboard-panel">
          <div className="section-header">
            <div>
              <h2>Reconnect queue</h2>
              <p className="section-subtitle">Sessions that still need attention from the operations team.</p>
            </div>
          </div>
          <div className="dashboard-list">
            {dashboard && dashboard.reconnectQueue.length > 0 ? (
              dashboard.reconnectQueue.map(session => (
                <div key={session.id} className="dashboard-list-row">
                  <div>
                    <strong>{session.openwaSessionName ?? session.openwaSessionId}</strong>
                    <span>{session.companyName ?? 'Unassigned workspace'}</span>
                  </div>
                  <strong>{session.phoneNumber ?? 'No number'}</strong>
                </div>
              ))
            ) : (
              <div className="dashboard-empty-state compact">All assigned sessions are healthy right now.</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
