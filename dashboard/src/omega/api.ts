import { API_BASE_URL } from '../services/api';

export type OmegaRole = 'super_admin' | 'support_admin' | 'client_admin' | 'client_agent';

export interface OmegaUser {
  id: string;
  fullName: string;
  email: string;
  role: OmegaRole;
  status: 'active' | 'inactive';
  isOnDuty: boolean;
  mustChangePassword: boolean;
  clientId?: string | null;
  teamId?: string | null;
  companyName?: string | null;
  workspaceName?: string | null;
  teamName?: string | null;
  lastLoginAt?: string | null;
}

export interface OmegaClient {
  id: string;
  companyName: string;
  ownerName: string;
  email: string;
  phone: string;
  status: 'active' | 'suspended';
  planId?: string | null;
  planName?: string;
  monthlyMessageLimit: number;
  whatsappAccountLimit: number;
  createdAt: string;
  sessionCount?: number;
  connectedSessions?: number;
  usageThisMonth?: number;
  subscriptionStatus?: string;
  userCount?: number;
}

export interface OmegaTeam {
  id: string;
  clientId: string;
  workspaceName?: string | null;
  name: string;
  description?: string | null;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
}

export interface OmegaPlan {
  id: string;
  name: string;
  description?: string | null;
  monthlyMessageLimit: number;
  whatsappAccountLimit: number;
  monthlyPrice: number;
  features: string[];
  isActive: boolean;
  activeClients?: number;
}

export interface OmegaSession {
  id: string;
  openwaSessionId: string;
  openwaSessionName?: string | null;
  clientId?: string | null;
  companyName?: string | null;
  phoneNumber?: string | null;
  status: 'connected' | 'disconnected' | 'needs_reconnect' | 'starting' | 'qr_required';
  assignedToClient: boolean;
  replacementRequested?: boolean;
  lastSeenAt?: string | null;
  lastSyncAt?: string | null;
  createdAt: string;
}

export interface OmegaUsageOverview {
  fallbackUsed: boolean;
  currentMonth: string;
  totals: { messagesToday: number; messagesThisMonth: number; reconnections: number };
  perClient: Array<{
    clientId: string;
    companyName: string;
    status: string;
    messagesToday: number;
    messagesThisMonth: number;
    monthlyMessageLimit: number;
    sessionCount: number;
    whatsappAccountLimit: number;
  }>;
  trend: Array<{ month: string; messages: number; reconnects: number }>;
  bySession: Array<{
    sessionId: string;
    openwaSessionId: string;
    openwaSessionName?: string | null;
    clientId?: string | null;
    messagesThisMonth: number;
  }>;
  byCampaign: Array<unknown>;
}

export interface OmegaDashboardSummary {
  brandName: string;
  stats: {
    totalClients: number;
    activeClients: number;
    suspendedClients: number;
    plans: number;
    totalSessions: number;
    connectedSessions: number;
    reconnectSessions: number;
    unassignedSessions: number;
    messagesToday: number;
    messagesThisMonth: number;
    staffCount: number;
    contactCount: number;
    contactGroupCount: number;
    campaigns: number;
  };
  monthlyTrend: Array<{ month: string; messages: number; reconnects: number }>;
  usageFallbackUsed?: boolean;
  topClients: Array<{ clientId: string; companyName: string; units: number }>;
  reconnectQueue: Array<{
    id: string;
    openwaSessionId: string;
    openwaSessionName?: string | null;
    phoneNumber?: string | null;
    companyName?: string | null;
    lastSeenAt?: string | null;
  }>;
}

export type OmegaAnalyticsPreset = 'day' | 'week' | 'month' | 'custom';

export interface OmegaEmployeeAnalytics {
  range: {
    preset: OmegaAnalyticsPreset;
    startDate: string;
    endDate: string;
  };
  summary: {
    activeEmployees: number;
    handledChats: number;
    assignedChats: number;
    closedChats: number;
    activeChats: number;
    firstResponseAvgMs: number | null;
    avgResponseMs: number | null;
  };
  employees: Array<{
    userId: string;
    fullName: string;
    email: string;
    role: OmegaRole;
    companyName?: string | null;
    handledChats: number;
    assignedChats: number;
    closedChats: number;
    activeChats: number;
    firstResponseAvgMs: number | null;
    avgResponseMs: number | null;
    repliesCount: number;
  }>;
}

export interface OmegaClientDetails extends OmegaClient {
  plan?: OmegaPlan | null;
  subscription?: {
    status: string;
    monthlyMessageLimit: number;
    whatsappAccountLimit: number;
    startsAt?: string | null;
    endsAt?: string | null;
  } | null;
  sessions: OmegaSession[];
  usageSummary: Array<{ month: string; messages: number; reconnects: number }>;
  usageStats?: {
    fallbackUsed: boolean;
    messagesToday: number;
    messagesThisMonth: number;
    monthlyMessageLimit: number;
    sessionCount: number;
    whatsappAccountLimit: number;
    trend: Array<{ month: string; messages: number }>;
    bySession: Array<{
      sessionId: string;
      openwaSessionId: string;
      openwaSessionName?: string | null;
      messagesThisMonth: number;
      status: string;
    }>;
  };
  staff: OmegaUser[];
  recentMessages: Array<{
    id: string;
    recipient: string;
    direction: string;
    status: string;
    body: string;
    sentAt?: string | null;
    createdAt: string;
  }>;
  contactsCount: number;
  contactGroupsCount: number;
}

export interface OmegaWorkspaceSession {
  id: string;
  openwaSessionId: string;
  openwaSessionName?: string | null;
  companyName?: string | null;
  phoneNumber?: string | null;
  status: 'connected' | 'disconnected' | 'needs_reconnect' | 'starting' | 'qr_required';
  assignedToClient: boolean;
  replacementRequested?: boolean;
  lastSeenAt?: string | null;
  lastSyncAt?: string | null;
  createdAt: string;
}

export interface OmegaWorkspaceChat {
  id: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  timestamp: number;
  lastMessage?: string;
  sessionId: string;
  sessionName: string;
  phoneNumber?: string | null;
}

export interface OmegaWorkspace {
  companyName?: string | null;
  sessions: OmegaWorkspaceSession[];
  chats: OmegaWorkspaceChat[];
  stats: {
    assignedSessions: number;
    activeSessions: number;
    totalChats: number;
  };
}

export interface OmegaWorkspaceMessages {
  messages: Array<{
    id: string;
    waMessageId?: string;
    chatId: string;
    from: string;
    to: string;
    body: string;
    type: string;
    direction: 'incoming' | 'outgoing';
    status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
    timestamp?: number;
    createdAt: string;
    metadata?: {
      media?: { mimetype: string; filename?: string; data?: string };
      quotedMessage?: { id: string; body: string };
      reactions?: Record<string, string>;
    };
  }>;
  total: number;
}

export interface OmegaSettings {
  brandName: string;
  architecture: {
    omegaLayer: string;
    openwaApiBaseUrl: string;
    openwaBaseUrl: string;
    openwaHttpClientConfigured: boolean;
    openwaMasterKeyConfigured: boolean;
    credentialsStoredInBackendOnly: boolean;
    existingAdminPanelUntouched: boolean;
  };
  operations: {
    activeAdminSessions: number;
    totalClients: number;
    totalSessions: number;
    authSessionTtlHours: number;
  };
  defaultAccounts: {
    superAdminEmail: string;
    supportAdminEmail: string;
  };
}

const OMEGA_TOKEN_KEY = 'omega_admin_token';
const OPENWA_API_KEY_STORAGE_KEY = 'openwa_api_key';

type OmegaRequestError = Error & { status?: number };

export function getOmegaToken() {
  return sessionStorage.getItem(OMEGA_TOKEN_KEY);
}

export function setOmegaToken(token: string) {
  sessionStorage.setItem(OMEGA_TOKEN_KEY, token);
}

export function clearOmegaToken() {
  sessionStorage.removeItem(OMEGA_TOKEN_KEY);
  localStorage.removeItem('omega_user_role');
}

function getOpenwaApiKey() {
  return localStorage.getItem(OPENWA_API_KEY_STORAGE_KEY) || sessionStorage.getItem(OPENWA_API_KEY_STORAGE_KEY);
}

async function parseJson(response: Response) {
  if (response.status === 204) {
    return null;
  }
  return response.json().catch(() => ({}));
}

async function omegaFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getOmegaToken();
  const openwaApiKey = getOpenwaApiKey();
  const response = await fetch(`${API_BASE_URL}/omega${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(!token && openwaApiKey ? { 'X-API-Key': openwaApiKey } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const payload = await parseJson(response);
    const message =
      typeof payload?.message === 'string'
        ? payload.message
        : Array.isArray(payload?.message)
          ? payload.message.join(', ')
          : `Request failed (${response.status})`;
    const error = new Error(message) as OmegaRequestError;
    error.status = response.status;
    throw error;
  }

  return (await parseJson(response)) as T;
}

export function isOmegaAuthError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const status = (error as OmegaRequestError).status;
  return (
    status === 401 ||
    status === 403 ||
    /session has expired|admin token|api key is required|invalid aurora credentials|aurora user is unavailable/i.test(
      error.message,
    )
  );
}

export async function omegaLogin(email: string, password: string) {
  return omegaFetch<{ token: string; expiresAt: string; user: OmegaUser }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function omegaLogout() {
  return omegaFetch<{ success: boolean }>('/auth/logout', { method: 'POST' });
}

export async function omegaMe() {
  return omegaFetch<OmegaUser>('/auth/me');
}

export async function omegaUpdateMe(fullName: string, password?: string, isOnDuty?: boolean) {
  return omegaFetch<OmegaUser>('/auth/me', {
    method: 'PATCH',
    body: JSON.stringify({
      fullName,
      ...(password ? { password } : {}),
      ...(isOnDuty !== undefined ? { isOnDuty } : {}),
    }),
  });
}

export async function omegaWorkspace() {
  return omegaFetch<OmegaWorkspace>('/auth/workspace');
}

export async function omegaWorkspaceMessages(sessionId: string, chatId: string, limit = 100) {
  return omegaFetch<OmegaWorkspaceMessages>(
    `/auth/workspace/messages/${encodeURIComponent(sessionId)}/${encodeURIComponent(chatId)}?limit=${limit}`,
  );
}

export async function omegaWorkspaceMarkRead(sessionId: string, chatId: string) {
  return omegaFetch<{ success: boolean }>(`/auth/workspace/chats/${encodeURIComponent(sessionId)}/read`, {
    method: 'POST',
    body: JSON.stringify({ chatId }),
  });
}

export async function omegaWorkspaceSendText(sessionId: string, chatId: string, text: string) {
  return omegaFetch<{ messageId: string; timestamp: number }>(
    `/auth/workspace/messages/${encodeURIComponent(sessionId)}/send-text`,
    {
      method: 'POST',
      body: JSON.stringify({ chatId, text }),
    },
  );
}

export const omegaApi = {
  me: omegaMe,
  updateMe: omegaUpdateMe,
  workspace: omegaWorkspace,
  workspaceMessages: omegaWorkspaceMessages,
  workspaceMarkRead: omegaWorkspaceMarkRead,
  workspaceSendText: omegaWorkspaceSendText,
  dashboard: () => omegaFetch<OmegaDashboardSummary>('/admin/dashboard'),
  employeeAnalytics: (filters?: { preset?: OmegaAnalyticsPreset; startDate?: string; endDate?: string }) => {
    const params = new URLSearchParams();
    if (filters?.preset) params.set('preset', filters.preset);
    if (filters?.startDate) params.set('startDate', filters.startDate);
    if (filters?.endDate) params.set('endDate', filters.endDate);
    const query = params.toString();
    return omegaFetch<OmegaEmployeeAnalytics>(`/admin/dashboard/employee-analytics${query ? `?${query}` : ''}`);
  },
  usage: () => omegaFetch<OmegaUsageOverview>('/usage'),
  settings: () => omegaFetch<OmegaSettings>('/admin/settings'),
  clients: () => omegaFetch<OmegaClient[]>('/clients'),
  teams: () => omegaFetch<OmegaTeam[]>('/teams'),
  client: (id: string) => omegaFetch<OmegaClientDetails>(`/clients/${id}`),
  clientSessions: (clientId: string) => omegaFetch<OmegaSession[]>(`/clients/${clientId}/sessions`),
  clientUsage: (clientId: string) =>
    omegaFetch<OmegaClientDetails['usageStats'] & { trend: Array<{ month: string; messages: number }> }>(
      `/clients/${clientId}/usage`,
    ),
  createClient: (payload: Partial<OmegaClient>) =>
    omegaFetch<OmegaClientDetails>('/clients', { method: 'POST', body: JSON.stringify(payload) }),
  updateClient: (id: string, payload: Partial<OmegaClient>) =>
    omegaFetch<OmegaClientDetails>(`/clients/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  createTeam: (payload: Partial<OmegaTeam>) =>
    omegaFetch<OmegaTeam>('/teams', { method: 'POST', body: JSON.stringify(payload) }),
  updateTeam: (id: string, payload: Partial<OmegaTeam>) =>
    omegaFetch<OmegaTeam>(`/teams/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  plans: () => omegaFetch<OmegaPlan[]>('/plans'),
  createPlan: (payload: Partial<OmegaPlan>) =>
    omegaFetch<OmegaPlan>('/plans', { method: 'POST', body: JSON.stringify(payload) }),
  updatePlan: (id: string, payload: Partial<OmegaPlan>) =>
    omegaFetch<OmegaPlan>(`/plans/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  sessions: (filters?: { status?: string; clientId?: string }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    if (filters?.clientId) params.set('clientId', filters.clientId);
    const query = params.toString();
    return omegaFetch<OmegaSession[]>(`/sessions${query ? `?${query}` : ''}`);
  },
  syncSessions: () => omegaFetch<OmegaSession[]>('/sessions/sync', { method: 'POST' }),
  assignSession: (sessionId: string, payload: { clientId?: string | null; overrideLimit?: boolean }) =>
    omegaFetch<OmegaSession>(`/sessions/${sessionId}/assign`, { method: 'POST', body: JSON.stringify(payload) }),
  unassignSession: (sessionId: string) =>
    omegaFetch<OmegaSession>(`/sessions/${sessionId}/unassign`, { method: 'POST' }),
  updateReplacement: (sessionId: string, replacementRequested: boolean) =>
    omegaFetch<OmegaSession>(`/sessions/${sessionId}/replacement`, {
      method: 'PATCH',
      body: JSON.stringify({ replacementRequested }),
    }),
  users: () => omegaFetch<OmegaUser[]>('/users'),
  createUser: (payload: Record<string, unknown>) =>
    omegaFetch<OmegaUser>('/users', { method: 'POST', body: JSON.stringify(payload) }),
  updateUser: (id: string, payload: Record<string, unknown>) =>
    omegaFetch<OmegaUser>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
};
