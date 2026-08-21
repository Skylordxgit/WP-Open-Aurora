import { useState, useEffect, lazy, Suspense, type ComponentType } from 'react';
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
  omegaApi,
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

const LAZY_RETRY_KEY = 'aurorawa_lazy_retry_path';

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

function lazyPage<TModule, TProps>(
  importer: () => Promise<TModule>,
  pickDefault: (module: TModule) => { default: ComponentType<TProps> },
) {
  return lazy(async () => {
    try {
      const module = await importer();
      sessionStorage.removeItem(LAZY_RETRY_KEY);
      return pickDefault(module);
    } catch (error) {
      const retryPath = sessionStorage.getItem(LAZY_RETRY_KEY);
      const currentPath = window.location.pathname;
      if (retryPath !== currentPath) {
        sessionStorage.setItem(LAZY_RETRY_KEY, currentPath);
        window.location.reload();
        return new Promise<never>(() => {});
      }
      throw error;
    }
  });
}

const Login = lazyPage(
  () => import('./pages/Login'),
  m => ({ default: m.Login }),
);
const ForcePasswordReset = lazyPage(
  () => import('./pages/ForcePasswordReset'),
  m => ({
    default: m.ForcePasswordReset,
  }),
);
const Dashboard = lazyPage(
  () => import('./pages/Dashboard'),
  m => ({ default: m.Dashboard }),
);
const Sessions = lazyPage(
  () => import('./pages/Sessions'),
  m => ({ default: m.Sessions }),
);
const Chats = lazyPage(
  () => import('./pages/Chats'),
  m => ({ default: m.Chats }),
);
const Webhooks = lazyPage(
  () => import('./pages/Webhooks'),
  m => ({ default: m.Webhooks }),
);
const Templates = lazyPage(
  () => import('./pages/Templates'),
  m => ({ default: m.Templates }),
);
const Logs = lazyPage(
  () => import('./pages/Logs'),
  m => ({ default: m.Logs }),
);
const ApiKeys = lazyPage(
  () => import('./pages/ApiKeys'),
  m => ({ default: m.ApiKeys }),
);
const Contacts = lazyPage(
  () => import('./pages/Contacts'),
  m => ({ default: m.Contacts }),
);
const BulkMessaging = lazyPage(
  () => import('./pages/BulkMessaging'),
  m => ({ default: m.BulkMessaging }),
);
const MessageTester = lazyPage(
  () => import('./pages/MessageTester'),
  m => ({ default: m.MessageTester }),
);
const Branding = lazyPage(
  () => import('./pages/Branding'),
  m => ({ default: m.Branding }),
);
const Infrastructure = lazyPage(
  () => import('./pages/Infrastructure'),
  m => ({ default: m.Infrastructure }),
);
const Plugins = lazyPage(
  () => import('./pages/Plugins'),
  m => ({ default: m.default }),
);
const OmegaClients = lazyPage(
  () => import('./omega/pages/OmegaClients'),
  m => ({ default: m.OmegaClients }),
);
const OmegaClientForm = lazyPage(
  () => import('./omega/pages/OmegaClientForm'),
  m => ({ default: m.OmegaClientForm }),
);
const OmegaClientDetails = lazyPage(
  () => import('./omega/pages/OmegaClientDetails'),
  m => ({
    default: m.OmegaClientDetails,
  }),
);
const OmegaStaff = lazyPage(
  () => import('./omega/pages/OmegaStaff'),
  m => ({ default: m.OmegaStaff }),
);
const OmegaTeams = lazyPage(
  () => import('./omega/pages/OmegaTeams'),
  m => ({ default: m.OmegaTeams }),
);
const OmegaBot = lazyPage(
  () => import('./omega/pages/OmegaBot'),
  m => ({ default: m.OmegaBot }),
);

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

  const handleRequiredPasswordReset = async (nextPassword: string) => {
    if (!authUser) {
      return;
    }

    const updatedUser = await omegaApi.updateMe(authUser.fullName, nextPassword);
    setAuthUser(updatedUser);
    setRole(mapOmegaRoleToDashboardRole(updatedUser.role));
    setStoredOmegaRole(updatedUser.role);
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

  if (authUser.mustChangePassword) {
    return (
      <Suspense fallback={loadingFallback}>
        <ForcePasswordReset
          fullName={authUser.fullName}
          onSubmit={handleRequiredPasswordReset}
          onLogout={handleLogout}
        />
      </Suspense>
    );
  }

  const isDashboardUser = isDashboardOmegaRole(authUser.role);
  const canAccessApiKeys = authUser.role === 'super_admin';
  const canAccessWebhooks = authUser.role === 'super_admin' || authUser.role === 'client_admin';
  const canAccessWorkspaces = authUser.role === 'super_admin';
  const canAccessUsers =
    authUser.role === 'super_admin' || authUser.role === 'support_admin' || authUser.role === 'client_admin';
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
              <Route
                path="/"
                element={<Layout onLogout={handleLogout} omegaRole={authUser.role} currentUser={authUser} />}
              >
                <Route index element={<Dashboard />} />
                <Route path="sessions" element={<Sessions />} />
                <Route path="chats" element={<Chats />} />
                {canAccessWebhooks && <Route path="webhooks" element={<Webhooks />} />}
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
