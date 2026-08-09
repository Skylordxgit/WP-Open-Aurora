import {
  BarChart3,
  FolderKanban,
  LayoutDashboard,
  LogIn,
  Megaphone,
  MessageSquare,
  Settings,
  Smartphone,
  Users2,
  UsersRound,
} from 'lucide-react';
import './ClientApp.css';

const sections = [
  { title: 'Login', description: 'Tenant authentication and account selection.', icon: LogIn },
  { title: 'Dashboard', description: 'Client-facing health, activity, and quick actions.', icon: LayoutDashboard },
  { title: 'WhatsApp Accounts', description: 'Assigned numbers, status, and reconnect visibility.', icon: Smartphone },
  { title: 'Contacts', description: 'Shared contact records for client operators.', icon: Users2 },
  { title: 'Contact Groups', description: 'Audience segmentation for messaging workflows.', icon: UsersRound },
  { title: 'Bulk Messaging', description: 'Campaign-ready sends with queue visibility.', icon: Megaphone },
  { title: 'Campaigns', description: 'Planned and active outreach tracking.', icon: FolderKanban },
  { title: 'Chats', description: 'Day-to-day conversation review and follow-up.', icon: MessageSquare },
  { title: 'Usage', description: 'Plan consumption, limits, and monthly trend visibility.', icon: BarChart3 },
  { title: 'Settings', description: 'Tenant preferences, operators, and workspace configuration.', icon: Settings },
] as const;

export function ClientApp() {
  return (
    <div className="client-app-shell">
      <aside className="client-app-sidebar">
        <div className="client-app-brand">
          <span className="client-app-mark">OA</span>
          <div>
            <strong>OpenWA Client Portal</strong>
            <span>/app</span>
          </div>
        </div>

        <nav className="client-app-nav" aria-label="Client portal sections">
          {sections.map(({ title, icon: Icon }) => (
            <div key={title} className="client-app-nav-item">
              <Icon size={16} />
              <span>{title}</span>
            </div>
          ))}
        </nav>
      </aside>

      <main className="client-app-main">
        <header className="client-app-header">
          <div>
            <p className="client-app-kicker">Client Portal Scaffold</p>
            <h1>Tenant-facing SaaS workspace</h1>
            <p>
              This `/app` surface is reserved for customer operations, while the internal OpenWA admin panel remains at
              `/`.
            </p>
          </div>
          <span className="client-app-badge">Preview</span>
        </header>

        <section className="client-app-grid">
          {sections.map(({ title, description, icon: Icon }) => (
            <article key={title} className="client-app-card">
              <div className="client-app-card-header">
                <span className="client-app-icon">
                  <Icon size={18} />
                </span>
                <h2>{title}</h2>
              </div>
              <p>{description}</p>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
