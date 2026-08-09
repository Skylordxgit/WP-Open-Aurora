import { useState, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { RoleProvider, useRole, type UserRole } from './hooks/useRole';
import { ErrorBoundary } from './components/ErrorBoundary';
import { API_BASE_URL } from './services/api';
import { ClientApp } from './client/ClientApp';
import './App.css';
import './omega/styles/omega.css';

const OPENWA_API_KEY_STORAGE_KEY = 'openwa_api_key';

function getStoredApiKey() {
  return localStorage.getItem(OPENWA_API_KEY_STORAGE_KEY) || sessionStorage.getItem(OPENWA_API_KEY_STORAGE_KEY);
}

function persistApiKey(key: string) {
  localStorage.setItem(OPENWA_API_KEY_STORAGE_KEY, key);
  sessionStorage.setItem(OPENWA_API_KEY_STORAGE_KEY, key);
}

function clearStoredApiKey() {
  localStorage.removeItem(OPENWA_API_KEY_STORAGE_KEY);
  sessionStorage.removeItem(OPENWA_API_KEY_STORAGE_KEY);
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
const Infrastructure = lazy(() => import('./pages/Infrastructure').then(m => ({ default: m.Infrastructure })));
const Plugins = lazy(() => import('./pages/Plugins'));
const OmegaClients = lazy(() => import('./omega/pages/OmegaClients').then(m => ({ default: m.OmegaClients })));
const OmegaClientForm = lazy(() => import('./omega/pages/OmegaClientForm').then(m => ({ default: m.OmegaClientForm })));
const OmegaClientDetails = lazy(() => import('./omega/pages/OmegaClientDetails').then(m => ({ default: m.OmegaClientDetails })));
const OmegaPlans = lazy(() => import('./omega/pages/OmegaPlans').then(m => ({ default: m.OmegaPlans })));
const OmegaStaff = lazy(() => import('./omega/pages/OmegaStaff').then(m => ({ default: m.OmegaStaff })));
const OmegaUsage = lazy(() => import('./omega/pages/OmegaUsage').then(m => ({ default: m.OmegaUsage })));
const OmegaBilling = lazy(() => import('./omega/pages/OmegaBilling').then(m => ({ default: m.OmegaBilling })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

function AppContent() {
  const savedKey = getStoredApiKey();
  const [isAuthenticated, setIsAuthenticated] = useState(!!savedKey);
  const [, setApiKey] = useState(savedKey || '');
  const { setRole, role } = useRole();

  const handleLogin = async (key: string) => {
    setApiKey(key);
    persistApiKey(key);

    // Fetch the role from API
    try {
      const response = await fetch(`${API_BASE_URL}/auth/validate`, {
        method: 'POST',
        headers: { 'X-API-Key': key },
      });
      if (response.ok) {
        const data = await response.json();
        setRole(data.role as UserRole);
      }
    } catch {
      // Default to viewer if we can't fetch role
      setRole('viewer');
    }

    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    setApiKey('');
    setIsAuthenticated(false);
    setRole(null);
    clearStoredApiKey();
  };

  // Re-validate and get role on mount if already authenticated
  useEffect(() => {
    if (!savedKey) return;

    fetch(`${API_BASE_URL}/auth/validate`, {
      method: 'POST',
      headers: { 'X-API-Key': savedKey },
    })
      .then(res => res.json())
      .then(data => {
        if (data.valid && data.role) {
          setRole(data.role as UserRole);
        }
      })
      .catch(() => {
        // Keep existing role from localStorage if validation fails
      });
  }, [savedKey, setRole]);

  const loadingFallback = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <Loader2 className="animate-spin" size={32} />
    </div>
  );

  if (!isAuthenticated) {
    return <Suspense fallback={loadingFallback}><Login onLogin={handleLogin} /></Suspense>;
  }

  return (
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={loadingFallback}>
        <Routes>
          <Route path="/" element={<Layout onLogout={handleLogout} userRole={role} />}>
            <Route index element={<Dashboard />} />
            <Route path="sessions" element={<Sessions />} />
            <Route path="chats" element={<Chats />} />
            <Route path="webhooks" element={<Webhooks />} />
            <Route path="templates" element={<Templates />} />
            <Route path="contacts" element={<Contacts />} />
            {role === 'admin' && <Route path="api-keys" element={<ApiKeys />} />}
            {role === 'admin' && <Route path="clients" element={<OmegaClients />} />}
            {role === 'admin' && <Route path="clients/new" element={<OmegaClientForm />} />}
            {role === 'admin' && <Route path="clients/:id" element={<OmegaClientDetails />} />}
            {role === 'admin' && <Route path="clients/:id/edit" element={<OmegaClientForm />} />}
            {role === 'admin' && <Route path="plans" element={<OmegaPlans />} />}
            {role === 'admin' && <Route path="users" element={<OmegaStaff />} />}
            {role === 'admin' && <Route path="usage" element={<OmegaUsage />} />}
            {role === 'admin' && <Route path="billing" element={<OmegaBilling />} />}
            <Route path="bulk-messaging" element={<BulkMessaging />} />
            <Route path="logs" element={<Logs />} />
            <Route path="message-tester" element={<MessageTester />} />
            <Route path="infrastructure" element={<Infrastructure />} />
            {role === 'admin' && <Route path="plugins" element={<Plugins />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}

function App() {
  if (window.location.pathname.startsWith('/app')) {
    return <ClientApp />;
  }

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
