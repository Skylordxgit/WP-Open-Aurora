import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  CalendarRange,
  Clock3,
  Loader2,
  MessageSquare,
  Send,
  Webhook,
} from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  useDashboardStatsQuery,
  useSessionsQuery,
  useStopSessionMutation,
  useWebhooksQuery,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import type { DashboardPeriod } from '../services/api';
import './Dashboard.css';

const formatInputDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export function Dashboard() {
  const { t } = useTranslation();
  useDocumentTitle(t('dashboard.title'));
  const navigate = useNavigate();
  const [period, setPeriod] = useState<DashboardPeriod>('today');
  const [startDate, setStartDate] = useState<string>(formatInputDate(new Date()));
  const [endDate, setEndDate] = useState<string>(formatInputDate(new Date()));

  const queryParams =
    period === 'custom'
      ? { period, startDate: `${startDate}T00:00:00.000Z`, endDate: `${endDate}T23:59:59.999Z` }
      : { period };

  const { data: analytics, isLoading: loadingAnalytics, error: analyticsError } = useDashboardStatsQuery(queryParams);
  const { data: sessions = [], isLoading: loadingSessions, error: sessionsError } = useSessionsQuery();
  const { data: webhooks = [] } = useWebhooksQuery();
  const stopMutation = useStopSessionMutation();

  const loading = loadingAnalytics || loadingSessions;
  const error = analyticsError instanceof Error
    ? analyticsError.message
    : sessionsError instanceof Error
      ? sessionsError.message
      : analyticsError || sessionsError
        ? t('dashboard.loadError')
        : null;

  const handleDisconnect = async (id: string) => {
    try {
      await stopMutation.mutateAsync(id);
    } catch (err) {
      console.error('Failed to disconnect:', err);
    }
  };

  const formatLastActive = (date?: string | null) => {
    if (!date) return t('common.never');
    const diff = Date.now() - new Date(date).getTime();
    if (diff < 60000) return t('common.justNow');
    if (diff < 3600000) return t('common.minAgo', { count: Math.floor(diff / 60000) });
    if (diff < 86400000) return t('common.hoursAgo', { count: Math.floor(diff / 3600000) });
    return new Date(date).toLocaleDateString();
  };

  const formatStatus = (status: string) => t(`sessionStatus.${status}`, { defaultValue: status });
  const formatMetric = (value: number | null | undefined, suffix = '') =>
    value == null ? '—' : `${value.toLocaleString()}${suffix}`;
  const formatResponse = (value: number | null | undefined) => (value == null ? '—' : `${value.toFixed(1)} min`);

  if (loading) {
    return (
      <div
        className="dashboard"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  if (error || !analytics) {
    return (
      <div className="dashboard" style={{ padding: '2rem' }}>
        <div style={{ background: '#FEE2E2', padding: '1rem', borderRadius: '8px', color: '#DC2626' }}>
          {t('dashboard.errorPrefix', { message: error || t('dashboard.loadError') })}
        </div>
      </div>
    );
  }

  const selected = analytics.messages.selectedPeriod;
  const statsCards = [
    {
      label: 'Chats handled',
      value: selected.handledChats,
      icon: MessageSquare,
      helper: `${selected.activeChats} active chats in range`,
    },
    {
      label: period === 'today' ? 'Messages today' : 'Messages in range',
      value: selected.total,
      icon: Send,
      helper: `${selected.received} inbound / ${selected.sent} outbound`,
    },
    {
      label: 'Average response time',
      value: formatResponse(selected.avgResponseMinutes),
      icon: Clock3,
      helper: `${selected.respondedChats} responded, ${selected.pendingChats} waiting`,
    },
    {
      label: 'Webhooks configured',
      value: webhooks.length,
      icon: Webhook,
      helper: `${analytics.sessions.active} connected sessions right now`,
    },
  ];

  return (
    <div className="dashboard">
      <PageHeader
        title={t('dashboard.title')}
        subtitle={t('dashboard.subtitle')}
        badge={
          <span className={`status-badge ${analytics.sessions.active > 0 ? 'connected' : 'disconnected'}`}>
            {analytics.sessions.active > 0 ? t('common.connected') : t('common.disconnected')}
          </span>
        }
      />

      <section className="dashboard-toolbar">
        <div className="dashboard-toolbar-group">
          {(['today', '7d', '30d', 'custom'] as DashboardPeriod[]).map(option => (
            <button
              key={option}
              type="button"
              className={`dashboard-filter-chip ${period === option ? 'active' : ''}`}
              onClick={() => setPeriod(option)}
            >
              {option === 'today' ? 'Today' : option === '7d' ? 'Weekly' : option === '30d' ? 'Monthly' : 'Custom'}
            </button>
          ))}
        </div>
        <div className="dashboard-toolbar-group dashboard-toolbar-group--dates">
          <div className="dashboard-date-field">
            <CalendarRange size={16} />
            <input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} disabled={period !== 'custom'} />
          </div>
          <div className="dashboard-date-field">
            <CalendarRange size={16} />
            <input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} disabled={period !== 'custom'} />
          </div>
        </div>
      </section>

      <div className="stats-grid">
        {statsCards.map(({ label, value, icon: Icon, helper }) => (
          <div key={label} className="stat-card">
            <Icon className="stat-watermark" />
            <div className="stat-header">
              <span className="stat-label">{label}</span>
              <Icon size={20} className="stat-icon" />
            </div>
            <div className="stat-value">{typeof value === 'number' ? value.toLocaleString() : value}</div>
            <div className="stat-helper">{helper}</div>
          </div>
        ))}
      </div>

      <section className="dashboard-insights-grid">
        <div className="dashboard-panel">
          <div className="section-header">
            <h2>Activity timeline</h2>
            <span className="section-subtitle">
              {new Date(analytics.range.startDate).toLocaleDateString()} to {new Date(analytics.range.endDate).toLocaleDateString()}
            </span>
          </div>
          <div className="activity-list">
            {analytics.activitySeries.length === 0 ? (
              <div className="activity-empty">No chat activity found for the selected range.</div>
            ) : (
              analytics.activitySeries.slice(-10).map(point => (
                <div key={point.label} className="activity-row">
                  <span className="activity-label">{point.label}</span>
                  <div className="activity-bars">
                    <span className="activity-pill incoming">{point.received} in</span>
                    <span className="activity-pill outgoing">{point.sent} out</span>
                    <span className="activity-pill handled">{point.handledChats} handled</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="dashboard-panel">
          <div className="section-header">
            <h2>Session productivity</h2>
            <span className="section-subtitle">{analytics.sessionPerformance.length} operator workspaces</span>
          </div>
          <div className="dashboard-kpis">
            <div className="dashboard-kpi-card">
              <span>Incoming</span>
              <strong>{selected.received.toLocaleString()}</strong>
            </div>
            <div className="dashboard-kpi-card">
              <span>Outgoing</span>
              <strong>{selected.sent.toLocaleString()}</strong>
            </div>
            <div className="dashboard-kpi-card">
              <span>Failed</span>
              <strong>{selected.failed.toLocaleString()}</strong>
            </div>
            <div className="dashboard-kpi-card">
              <span>Avg/day</span>
              <strong>{formatMetric(analytics.sessionPerformance.reduce((sum, row) => sum + row.messagesPerDay, 0))}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="sessions-section">
        <div className="section-header">
          <h2>Operator performance by session</h2>
          <span className="section-subtitle">
            {analytics.sessionPerformance.length} sessions tracked across {analytics.range.days} day{analytics.range.days === 1 ? '' : 's'}
          </span>
        </div>

        <div className="analytics-table">
          <div className="table-header analytics-table-header">
            <span>Session</span>
            <span>Handled chats</span>
            <span>Messages</span>
            <span>Response time</span>
            <span>Last reply</span>
            <span>Actions</span>
          </div>
          {analytics.sessionPerformance.length === 0 ? (
            <div className="table-row analytics-table-row analytics-table-row--empty">No session analytics found for this range.</div>
          ) : (
            analytics.sessionPerformance.map(row => {
              const liveSession = sessions.find(session => session.id === row.sessionId);
              return (
                <div key={row.sessionId} className="table-row analytics-table-row">
                  <div className="session-info-cell">
                    <span className="session-id">{row.name}</span>
                    <span className="session-name" title={row.sessionId}>
                      {row.phone || row.sessionId.slice(0, 18)}
                    </span>
                    <span className={`status-pill ${liveSession?.status || row.status}`}>{formatStatus(liveSession?.status || row.status)}</span>
                  </div>
                  <div className="metric-stack">
                    <strong>{row.handledChats}</strong>
                    <span>{row.activeChats} active chats</span>
                  </div>
                  <div className="metric-stack">
                    <strong>{row.incoming + row.outgoing}</strong>
                    <span>
                      {row.incoming} in / {row.outgoing} out
                    </span>
                  </div>
                  <div className="metric-stack">
                    <strong>{formatResponse(row.avgResponseMinutes)}</strong>
                    <span>{row.failed} failed</span>
                  </div>
                  <div className="metric-stack">
                    <strong>{formatLastActive(row.lastResponseAt)}</strong>
                    <span>{row.lastInboundAt ? `Inbound ${formatLastActive(row.lastInboundAt)}` : 'No inbound yet'}</span>
                  </div>
                  <div className="actions">
                    <button className="btn-sm" onClick={() => navigate('/sessions')}>
                      {t('dashboard.view')}
                    </button>
                    {liveSession && ['ready', 'initializing', 'connecting', 'qr_ready'].includes(liveSession.status) && (
                      <button className="btn-sm danger" onClick={() => handleDisconnect(liveSession.id)}>
                        {t('dashboard.disconnect')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      <section className="sessions-section">
        <div className="section-header">
          <h2>{t('dashboard.sessionsOverview')}</h2>
          <span className="section-subtitle">
            {t('dashboard.showingSessions', { shown: sessions.length, total: analytics.sessions.total })}
          </span>
        </div>

        <div className="sessions-table">
          <div className="table-header">
            <span>{t('dashboard.columns.sessionId')}</span>
            <span>{t('dashboard.columns.phone')}</span>
            <span>{t('dashboard.columns.status')}</span>
            <span>{t('dashboard.columns.lastActive')}</span>
            <span>{t('dashboard.columns.actions')}</span>
          </div>
          {sessions.length === 0 ? (
            <div className="table-row" style={{ justifyContent: 'center', color: 'var(--text-muted)' }}>
              {t('dashboard.noSessions')}
            </div>
          ) : (
            sessions.map(session => (
              <div key={session.id} className="table-row">
                <div className="session-info-cell">
                  <span className="session-id">{session.id.substring(0, 12)}</span>
                  <span className="session-name" title={session.name}>
                    {session.name}
                  </span>
                </div>
                <span className="phone">{session.phone || '—'}</span>
                <span className={`status-pill ${session.status}`}>{formatStatus(session.status)}</span>
                <span className="last-active">{formatLastActive(session.lastActive)}</span>
                <div className="actions">
                  <button className="btn-sm" onClick={() => navigate('/sessions')}>
                    {t('dashboard.view')}
                  </button>
                  {['ready', 'initializing', 'connecting', 'qr_ready'].includes(session.status) && (
                    <button className="btn-sm danger" onClick={() => handleDisconnect(session.id)}>
                      {t('dashboard.disconnect')}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
