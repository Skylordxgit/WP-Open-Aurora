import { useState, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { RoleProvider, useRole, type UserRole } from './hooks/useRole';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  clearOmegaToken,
  getOmegaToken,
  isOmegaAuthError,
  omegaLogin,
  omegaLogout,
  omegaMe,
  setOmegaToken,
  type OmegaRole,
  type OmegaUser,
} from './omega/api';
import { ClientApp } from './client/ClientApp';
import './App.css';
import './omega/styles/omega.css';

function clearStoredApiKey() {
  localStorage.removeItem('openwa_api_key');
  sessionStorage.removeItem('openwa_api_key');
}

function setStoredOmegaRole(role: OmegaRole | null) {
  if (role) {
    localStorage.setItem('omega_user_role', role);
    return;
  }
  localStorage.removeItem('omega_user_role');
}

const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Sessions = lazy(() => import('./pages/Sessions').then(m => ({ default: m.Sessions })));
const Chats = lazy(() => import('./pages/Chats').then(m => ({ default: m.Chats })));
const Webhooks = lazy(() => import('./pages/Webhooks').then(m => ({ default: m.Webhooks })));
const Templates = lazy(() => import('./pages/Templates').then(m => ({ default: m.Templates })));
const Logs = lazy(() => import('./pages/Logs').then(m => ({ default: m.Logs })));
const ApiKeys = lazy(() => import('./pages/ApiKeys').then(m => ({ default: m.ApiKeys })));
const Contacts = lazy(() => import('./pages/Contacts').then(m => ({ default: m.Contacts })));
const BulkMessaging = lazy(() => import('./pages/BulkMessaging').then(m => ({ default: m.BulkMessaging })));
const MessageTester = lazy(() => import('./pages/MessageTester').then(m => ({ default: m.MessageTester })));
const Branding = lazy(() => import('./pages/Branding').then(m => ({ default: m.Branding })));
const Infrastructure = lazy(() => import('./pages/Infrastructure').then(m => ({ default: m.Infrastructure })));
const Plugins = lazy(() => import('./pages/Plugins'));
const OmegaClients = lazy(() => import('./omega/pages/OmegaClients').then(m => ({ default: m.OmegaClients })));
const OmegaClientForm = lazy(() => import('./omega/pages/OmegaClientForm').then(m => ({ default: m.OmegaClientForm })));
const OmegaClientDetails = lazy(() => import('./omega/pages/OmegaClientDetails').then(m => ({ default: m.OmegaClientDetails })));
const OmegaStaff = lazy(() => import('./omega/pages/OmegaStaff').then(m => ({ default: m.OmegaStaff })));
const OmegaTeams = lazy(() => import('./omega/pages/OmegaTeams').then(m => ({ default: m.OmegaTeams })));
const OmegaBot = lazy(() => import('./omega/pages/OmegaBot').then(m => ({ default: m.OmegaBot })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

function isDashboardOmegaRole(role: OmegaRole) {
  return role === 'super_admin' || role === 'support_admin' || role === 'client_admin';
}

function mapOmegaRoleToDashboardRole(role: OmegaRole): UserRole {
  if (role === 'super_admin' || role === 'support_admin') {
    return 'admin';
  }
  if (role === 'client_admin') {
    return 'operator';
  }
  return 'viewer';
}

async function withOmegaSessionRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (isOmegaAuthError(error) || attempt === attempts - 1) {
        throw error;
      }

      await new Promise(resolve => window.setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unable to restore Aurora session');
}

function AppContent() {
  const [authUser, setAuthUser] = useState<OmegaUser | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const { setRole } = useRole();

  const handleLogin = async (identifier: string, password: string) => {
    const result = await omegaLogin(identifier, password);
    setOmegaToken(result.token);
    const user = result.user ?? (await omegaMe());
    setAuthUser(user);
    setRole(mapOmegaRoleToDashboardRole(user.role));
    setStoredOmegaRole(user.role);
    clearStoredApiKey();
  };

  const handleLogout = () => {
    void omegaLogout().catch(() => undefined);
    clearOmegaToken();
    clearStoredApiKey();
    setStoredOmegaRole(null);
    setAuthUser(null);
    setRole(null);
  };

  useEffect(() => {
    const token = getOmegaToken();
    if (!token) {
      setIsCheckingSession(false);
      return;
    }

    withOmegaSessionRetry(() => omegaMe())
      .then(user => {
        setAuthUser(user);
        setRole(mapOmegaRoleToDashboardRole(user.role));
        setStoredOmegaRole(user.role);
        clearStoredApiKey();
      })
      .catch(error => {
        if (isOmegaAuthError(error)) {
          clearOmegaToken();
          setStoredOmegaRole(null);
          setAuthUser(null);
          setRole(null);
        }
      })
      .finally(() => {
        setIsCheckingSession(false);
      });
  }, [setRole]);

  const loadingFallback = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <Loader2 className="animate-spin" size={32} />
    </div>
  );

  if (isCheckingSession) {
    return loadingFallback;
  }

  if (!authUser) {
    return (
      <Suspense fallback={loadingFallback}>
        <Login onLogin={handleLogin} />
      </Suspense>
    );
  }

  const isDashboardUser = isDashboardOmegaRole(authUser.role);
  const canAccessApiKeys = authUser.role === 'super_admin';
  const canAccessWorkspaces = authUser.role === 'super_admin' || authUser.role === 'support_admin';
  const canAccessUsers = authUser.role === 'super_admin' || authUser.role === 'support_admin' || authUser.role === 'client_admin';
  const canAccessTeams = canAccessUsers;
  const canAccessBot = canAccessUsers;
  const canAccessBranding = authUser.role === 'super_admin' || authUser.role === 'support_admin';
  const canAccessInfrastructure = authUser.role === 'super_admin';
  const canAccessPlugins = authUser.role === 'super_admin';

  return (
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={loadingFallback}>
          <Routes>
            {isDashboardUser ? (
              <Route path="/" element={<Layout onLogout={handleLogout} omegaRole={authUser.role} />}>
                <Route index element={<Dashboard />} />
                <Route path="sessions" element={<Sessions />} />
                <Route path="chats" element={<Chats />} />
                <Route path="webhooks" element={<Webhooks />} />
                <Route path="templates" element={<Templates />} />
                <Route path="contacts" element={<Contacts />} />
                {canAccessApiKeys && <Route path="api-keys" element={<ApiKeys />} />}
                {canAccessWorkspaces && <Route path="clients" element={<OmegaClients />} />}
                {canAccessWorkspaces && <Route path="clients/new" element={<OmegaClientForm />} />}
                {canAccessWorkspaces && <Route path="clients/:id" element={<OmegaClientDetails />} />}
                {canAccessWorkspaces && <Route path="clients/:id/edit" element={<OmegaClientForm />} />}
                {canAccessUsers && <Route path="users" element={<OmegaStaff />} />}
                {canAccessTeams && <Route path="teams" element={<OmegaTeams />} />}
                {canAccessBot && <Route path="bot" element={<OmegaBot />} />}
                <Route path="bulk-messaging" element={<BulkMessaging />} />
                <Route path="logs" element={<Logs />} />
                <Route path="message-tester" element={<MessageTester />} />
                {canAccessBranding && <Route path="branding" element={<Branding />} />}
                {canAccessInfrastructure && <Route path="infrastructure" element={<Infrastructure />} />}
                {canAccessPlugins && <Route path="plugins" element={<Plugins />} />}
                <Route path="app" element={<Navigate to="/" replace />} />
                <Route path="workspace" element={<Navigate to="/" replace />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            ) : (
              <>
                <Route path="/" element={<ClientApp standalone={false} onLoggedOut={handleLogout} />} />
                <Route path="/app" element={<Navigate to="/" replace />} />
                <Route path="/workspace" element={<Navigate to="/" replace />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </>
            )}
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RoleProvider>
          <AppContent />
        </RoleProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
