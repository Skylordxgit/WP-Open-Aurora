import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown,
  ChevronDown,
  Filter,
  MessageCircleMore,
  Monitor,
  Moon,
  RefreshCcw,
  Search,
  SendHorizontal,
  Sun,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '../services/api';
import { asMessageType } from '../services/api';
import { useBranding } from '../hooks/useBranding';
import { useTheme } from '../hooks/useTheme';
import { languageOptions, resolveSupportedLanguage } from '../i18n';
import {
  clearOmegaToken,
  isOmegaAuthError,
  omegaApi,
  omegaLogin,
  omegaLogout,
  omegaMe,
  omegaWorkspace,
  omegaWorkspaceMarkRead,
  omegaWorkspaceMessages,
  omegaWorkspaceSendText,
  type OmegaUser,
  type OmegaWorkspace,
  type OmegaWorkspaceChat,
} from '../omega/api';
import './ClientApp.css';

type ClientPortalUser = OmegaUser;
type InboxFilter = 'queue' | 'inbox' | 'groups';
type InboxStatusFilter = 'all' | 'open' | 'closed';
type InboxSort = 'latest' | 'oldest' | 'started_last' | 'started_first' | 'waiting_longest';
type ChannelFilter = 'all' | 'whatsapp' | 'telegram';

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

  throw lastError instanceof Error ? lastError : new Error('Unable to refresh Aurora workspace');
}

function getUserPortalSession() {
  return sessionStorage.getItem('omega_admin_token');
}

function getChatKey(chat: OmegaWorkspaceChat) {
  return `${chat.sessionId}:${chat.id}`;
}

function formatRole(role: string) {
  const roleLabels: Record<string, string> = {
    super_admin: 'Master Admin',
    support_admin: 'Super Admin',
    client_admin: 'Sub Admin',
    client_agent: 'Employee',
  };

  return roleLabels[role] ?? role.replace(/_/g, ' ');
}

function getInitials(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() ?? '')
    .join('');
}

function formatChatTime(timestamp?: number) {
  if (!timestamp) return '';

  const date = new Date(timestamp * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatMessageTime(value?: number | string) {
  if (!value) return '';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ClientApp({ standalone = true, onLoggedOut }: { standalone?: boolean; onLoggedOut?: () => void }) {
  const { t, i18n } = useTranslation();
  const branding = useBranding();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [user, setUser] = useState<ClientPortalUser | null>(null);
  const [workspace, setWorkspace] = useState<OmegaWorkspace | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRefreshingWorkspace, setIsRefreshingWorkspace] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ email: '', password: '' });
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<InboxFilter>('queue');
  const [inboxStatusFilter, setInboxStatusFilter] = useState<InboxStatusFilter>('open');
  const [inboxSort, setInboxSort] = useState<InboxSort>('started_first');
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all');
  const [isStatusMenuOpen, setIsStatusMenuOpen] = useState(false);
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const [isChannelMenuOpen, setIsChannelMenuOpen] = useState(false);
  const [selectedChatKey, setSelectedChatKey] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false);
  const [isUpdatingDuty, setIsUpdatingDuty] = useState(false);
  const [profileForm, setProfileForm] = useState({ fullName: '', password: '' });
  const [profileError, setProfileError] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const languageMenuRef = useRef<HTMLDivElement>(null);
  const inboxControlsRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user) {
      setProfileForm({ fullName: '', password: '' });
      return;
    }

    setProfileForm({ fullName: user.fullName, password: '' });
  }, [user]);

  useEffect(() => {
    if (!isLanguageMenuOpen) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!languageMenuRef.current?.contains(event.target as Node)) {
        setIsLanguageMenuOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsLanguageMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);

    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isLanguageMenuOpen]);

  useEffect(() => {
    if (!isProfileMenuOpen) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) {
        setIsProfileMenuOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsProfileMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);

    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isProfileMenuOpen]);

  useEffect(() => {
    if (!isStatusMenuOpen && !isSortMenuOpen && !isChannelMenuOpen) return;

    const closeMenus = (event: MouseEvent) => {
      if (!inboxControlsRef.current?.contains(event.target as Node)) {
        setIsStatusMenuOpen(false);
        setIsSortMenuOpen(false);
        setIsChannelMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', closeMenus);
    return () => {
      document.removeEventListener('mousedown', closeMenus);
    };
  }, [isChannelMenuOpen, isSortMenuOpen, isStatusMenuOpen]);

  const loadWorkspace = useCallback(async (silent = false) => {
    if (!silent) {
      setIsRefreshingWorkspace(true);
    }

    try {
      const currentWorkspace = await withOmegaSessionRetry(() => omegaWorkspace());
      setWorkspace(currentWorkspace);
      return currentWorkspace;
    } finally {
      if (!silent) {
        setIsRefreshingWorkspace(false);
      }
    }
  }, []);

  useEffect(() => {
    const token = getUserPortalSession();
    if (!token) {
      setIsCheckingSession(false);
      if (!standalone) {
        onLoggedOut?.();
      }
      return;
    }

    withOmegaSessionRetry(() => omegaMe())
      .then(async currentUser => {
        setUser(currentUser);
        await loadWorkspace();
      })
      .catch(error => {
        if (isOmegaAuthError(error)) {
          clearOmegaToken();
          setUser(null);
          setWorkspace(null);
          setMessages([]);
          onLoggedOut?.();
          return;
        }

        setError(error instanceof Error ? error.message : 'Unable to restore your workspace');
      })
      .finally(() => {
        setIsCheckingSession(false);
      });
  }, [loadWorkspace, onLoggedOut, standalone]);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    let timer: number | undefined;

    const pollWorkspace = async () => {
      let nextPollMs = 8000;
      try {
        const refreshedWorkspace = await loadWorkspace(true);
        if (refreshedWorkspace.chats.length === 0) {
          nextPollMs = 1500;
        }
      } catch {
        // Keep the current inbox visible and retry on the normal interval.
      }

      if (!cancelled) {
        timer = window.setTimeout(pollWorkspace, nextPollMs);
      }
    };

    timer = window.setTimeout(pollWorkspace, 1500);

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [user, loadWorkspace]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = branding.tabTitle;

    return () => {
      document.title = previousTitle;
    };
  }, [branding.tabTitle]);

  const workspaceChats = useMemo(() => workspace?.chats ?? [], [workspace?.chats]);

  const filteredChats = useMemo(() => {
    return workspaceChats
      .filter(chat => {
        if (inboxStatusFilter === 'closed') return false;
        const matchesSearch =
          chat.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          chat.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
          chat.sessionName.toLowerCase().includes(searchQuery.toLowerCase());

        if (!matchesSearch) return false;
        if (activeFilter === 'inbox') return !chat.isGroup;
        if (activeFilter === 'groups') return chat.isGroup;
        return true;
      })
      .sort((a, b) => {
        if (inboxSort === 'oldest' || inboxSort === 'started_first') {
          return (a.timestamp || 0) - (b.timestamp || 0);
        }
        if (inboxSort === 'waiting_longest') {
          return (b.unreadCount || 0) - (a.unreadCount || 0) || (a.timestamp || 0) - (b.timestamp || 0);
        }
        return (b.timestamp || 0) - (a.timestamp || 0);
      });
  }, [activeFilter, inboxSort, inboxStatusFilter, searchQuery, workspaceChats]);

  useEffect(() => {
    if (!workspaceChats.length) {
      setSelectedChatKey('');
      setMessages([]);
      return;
    }

    const stillExists = workspaceChats.some(chat => getChatKey(chat) === selectedChatKey);
    if (!stillExists) {
      setSelectedChatKey(getChatKey(workspaceChats[0]));
    }
  }, [selectedChatKey, workspaceChats]);

  const activeChat =
    workspaceChats.find(chat => getChatKey(chat) === selectedChatKey) ??
    filteredChats.find(chat => getChatKey(chat) === selectedChatKey) ??
    null;

  const loadMessages = useCallback(async (chat: OmegaWorkspaceChat) => {
    setLoadingMessages(true);

    try {
      await omegaWorkspaceMarkRead(chat.sessionId, chat.id).catch(() => undefined);
      const response = await omegaWorkspaceMessages(chat.sessionId, chat.id, 100);
      setMessages([...response.messages].reverse().map(message => ({ ...message, type: asMessageType(message.type) })));
      setWorkspace(current =>
        current
          ? {
              ...current,
              chats: current.chats.map(item =>
                getChatKey(item) === getChatKey(chat) ? { ...item, unreadCount: 0 } : item,
              ),
            }
          : current,
      );
    } catch (messageError) {
      setMessages([]);
      setError(messageError instanceof Error ? messageError.message : 'Unable to load messages');
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    if (!activeChat) return;
    setError('');
    void loadMessages(activeChat);
  }, [activeChat, loadMessages]);

  useEffect(() => {
    if (!activeChat) return;

    const interval = window.setInterval(() => {
      void loadMessages(activeChat);
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [activeChat, loadMessages]);

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError('');

    try {
      const result = await omegaLogin(form.email, form.password);
      sessionStorage.setItem('omega_admin_token', result.token);
      const currentUser = await omegaMe();
      setUser(currentUser);
      await loadWorkspace();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Unable to sign in');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await omegaLogout();
    } catch {
      // Keep logout resilient even if the server session already expired.
    }
    clearOmegaToken();
    setUser(null);
    setWorkspace(null);
    setMessages([]);
    setSelectedChatKey('');
    setForm({ email: '', password: '' });
    onLoggedOut?.();
  };

  const handleProfileSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) {
      return;
    }

    setIsSavingProfile(true);
    setProfileError('');

    try {
      const updatedUser = await omegaApi.updateMe(profileForm.fullName, profileForm.password);
      setUser(updatedUser);
      await loadWorkspace(true);
      setProfileForm({ fullName: updatedUser.fullName, password: '' });
      setIsProfileModalOpen(false);
    } catch (saveError) {
      setProfileError(saveError instanceof Error ? saveError.message : 'Unable to update profile');
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleDutyToggle = async () => {
    if (!user || isUpdatingDuty) {
      return;
    }

    const nextDuty = !user.isOnDuty;
    setIsUpdatingDuty(true);
    setError('');

    try {
      const updatedUser = await omegaApi.updateMe(user.fullName, undefined, nextDuty);
      setUser(updatedUser);
      await loadWorkspace(true);
    } catch (dutyError) {
      if (isOmegaAuthError(dutyError)) {
        await handleLogout();
        return;
      }
      setError(dutyError instanceof Error ? dutyError.message : 'Unable to update duty status');
    } finally {
      setIsUpdatingDuty(false);
    }
  };

  const handleSend = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeChat || !messageInput.trim() || isSending || !user?.isOnDuty) {
      return;
    }

    const outgoingText = messageInput.trim();
    const optimisticMessage: ChatMessage = {
      id: `temp-${Date.now()}`,
      chatId: activeChat.id,
      from: user?.email ?? 'me',
      to: activeChat.id,
      body: outgoingText,
      type: 'text',
      direction: 'outgoing',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    setIsSending(true);
    setError('');
    setMessageInput('');
    setMessages(current => [...current, optimisticMessage]);

    try {
      await omegaWorkspaceSendText(activeChat.sessionId, activeChat.id, outgoingText);
      await Promise.all([loadMessages(activeChat), loadWorkspace(true)]);
    } catch (sendError) {
      setMessages(current =>
        current.map(message => (message.id === optimisticMessage.id ? { ...message, status: 'failed' } : message)),
      );
      setError(sendError instanceof Error ? sendError.message : 'Unable to send message');
    } finally {
      setIsSending(false);
    }
  };

  const handleInboxRefresh = async () => {
    setError('');

    try {
      const refreshedWorkspace = await loadWorkspace();

      if (!activeChat) {
        return;
      }

      const refreshedChat =
        refreshedWorkspace.chats.find(chat => getChatKey(chat) === getChatKey(activeChat)) ?? activeChat;

      await loadMessages(refreshedChat);
    } catch (refreshError) {
      if (isOmegaAuthError(refreshError)) {
        await handleLogout();
        return;
      }

      setError(refreshError instanceof Error ? refreshError.message : 'Unable to refresh the inbox');
    }
  };

  const inboxChats = workspaceChats.filter(chat => !chat.isGroup).length;
  const groupChats = workspaceChats.filter(chat => chat.isGroup).length;
  const activeWorkspaceName = workspace?.companyName ?? user?.companyName ?? branding.appName;
  const currentLanguage = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);
  const languageLabel = languageOptions.find(option => option.value === currentLanguage)?.compactLabel ?? 'EN';
  const channelLabel =
    channelFilter === 'whatsapp' ? 'WhatsApp' : channelFilter === 'telegram' ? 'Telegram' : 'All channels';
  const inboxStatusLabel = inboxStatusFilter === 'all' ? 'All' : inboxStatusFilter === 'open' ? 'Open' : 'Closed';
  const inboxSortLabel =
    inboxSort === 'latest'
      ? 'Latest'
      : inboxSort === 'oldest'
        ? 'Oldest'
        : inboxSort === 'started_last'
          ? 'Started last'
          : inboxSort === 'started_first'
            ? 'Started first'
            : 'Waiting longest';
  const effectiveTheme = theme === 'system' ? resolvedTheme : theme;
  const ThemeIcon = theme === 'system' ? Monitor : effectiveTheme === 'dark' ? Moon : Sun;
  const themeLabel =
    theme === 'system'
      ? t('theme.system', { defaultValue: 'System' })
      : effectiveTheme === 'dark'
        ? t('theme.dark', { defaultValue: 'Dark' })
        : t('theme.light', { defaultValue: 'Light' });
  const isOffDuty = !(user?.isOnDuty ?? true);

  const handleThemeToggle = () => {
    if (theme === 'dark') {
      setTheme('light');
      return;
    }
    if (theme === 'light') {
      setTheme('system');
      return;
    }
    setTheme('dark');
  };

  if (isCheckingSession) {
    return (
      <div className="client-login-shell">
        <div className="client-login-card">
          <strong>{t('clientPortal.checkingSession', { defaultValue: 'Checking user session...' })}</strong>
        </div>
      </div>
    );
  }

  if (!user) {
    if (!standalone) {
      return null;
    }

    return (
      <div className="client-login-shell">
        <div className="client-login-card">
          <div className="client-login-brandbar">
            <img src={branding.logoSrc} alt={branding.appName} className="client-brand-logo" />
            <div>
              <strong>{branding.appName}</strong>
              <span>{branding.appSubtitle}</span>
            </div>
          </div>

          <div className="client-login-hero">
            <div>
              <h1>{t('login.connect', { defaultValue: 'Login' })}</h1>
            </div>
          </div>

          <form className="client-login-form" onSubmit={handleLogin}>
            <label>
              <span>{t('common.username', { defaultValue: 'Email' })}</span>
              <input
                type="email"
                value={form.email}
                onChange={event => setForm({ ...form, email: event.target.value })}
                placeholder={t('clientPortal.emailPlaceholder', { defaultValue: 'name@company.com' })}
              />
            </label>
            <label>
              <span>{t('common.password', { defaultValue: 'Password' })}</span>
              <input
                type="password"
                value={form.password}
                onChange={event => setForm({ ...form, password: event.target.value })}
                placeholder={t('clientPortal.passwordPlaceholder', { defaultValue: 'Enter your password' })}
              />
            </label>
            {error && <div className="client-login-error">{error}</div>}
            <button className="client-login-button" type="submit" disabled={isSubmitting}>
              {isSubmitting
                ? t('clientPortal.signingIn', { defaultValue: 'Signing in...' })
                : t('login.connect', { defaultValue: 'Login' })}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="client-inbox-shell">
      <aside className="client-rail">
        <div className="client-rail-brand">
          <img src={branding.logoSrc} alt={branding.appName} className="client-brand-logo client-brand-logo-sidebar" />
          <div className="client-rail-brand-copy">
            <strong>{branding.appName}</strong>
            <span>{branding.appSubtitle}</span>
          </div>
        </div>

        <button className="client-rail-action client-rail-action-active" type="button">
          <MessageCircleMore size={18} />
          <span>{t('clientPortal.liveChat', { defaultValue: 'Live chat' })}</span>
        </button>

        <div className="client-language-menu" ref={languageMenuRef}>
          <button className="client-rail-action" type="button" onClick={() => setIsLanguageMenuOpen(open => !open)}>
            <span>{languageLabel}</span>
            <span>{t('common.language', { defaultValue: 'Language' })}</span>
          </button>
          {isLanguageMenuOpen && (
            <div className="client-language-menu-list">
              {languageOptions.map(option => (
                <button
                  key={option.value}
                  className={`client-language-menu-item ${option.value === currentLanguage ? 'active' : ''}`}
                  type="button"
                  onClick={() => {
                    setIsLanguageMenuOpen(false);
                    void i18n.changeLanguage(option.value);
                  }}
                >
                  <span>{option.compactLabel}</span>
                  <strong>{option.label}</strong>
                </button>
              ))}
            </div>
          )}
        </div>

        <button className="client-rail-action" type="button" onClick={handleThemeToggle}>
          <ThemeIcon size={18} />
          <span>{themeLabel}</span>
        </button>

        <div className="client-rail-profile-area">
          <div className="client-profile-menu-wrap client-profile-menu-wrap-sidebar" ref={profileMenuRef}>
            <button
              className="client-profile-trigger"
              type="button"
              onClick={() => setIsProfileMenuOpen(open => !open)}
            >
              <div className="client-profile-avatar">{getInitials(user.fullName)}</div>
              <div className="client-profile-trigger-copy">
                <strong>{getInitials(user.fullName)}</strong>
                <span>
                  {isOffDuty
                    ? t('clientPortal.offDuty', { defaultValue: 'Off duty' })
                    : t('clientPortal.onDuty', { defaultValue: 'On duty' })}
                </span>
              </div>
              <ChevronDown size={16} />
            </button>
            {isProfileMenuOpen && (
              <div className="client-profile-menu client-profile-menu-sidebar">
                <div className="client-duty-row">
                  <span>
                    {user.isOnDuty
                      ? t('clientPortal.onDuty', { defaultValue: 'On duty' })
                      : t('clientPortal.offDuty', { defaultValue: 'Off duty' })}
                  </span>
                  <button
                    className={`client-duty-toggle ${user.isOnDuty ? 'active' : ''}`}
                    type="button"
                    onClick={() => void handleDutyToggle()}
                    disabled={isUpdatingDuty}
                  >
                    <span />
                  </button>
                </div>
                <button
                  className="client-profile-menu-button"
                  type="button"
                  onClick={() => {
                    setIsProfileModalOpen(true);
                    setIsProfileMenuOpen(false);
                  }}
                >
                  {t('clientPortal.viewProfile', { defaultValue: 'View Profile' })}
                </button>
                <button
                  className="client-profile-menu-button client-profile-menu-button-danger"
                  type="button"
                  onClick={handleLogout}
                >
                  {t('common.logout', { defaultValue: 'Logout' })}
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <aside className="client-queues">
        <div className="client-queues-header">
          <div>
            <strong>{branding.appName}</strong>
            <span>{branding.appSubtitle}</span>
            <small>{activeWorkspaceName}</small>
          </div>
        </div>

        <div className="client-queues-section">
          <p className="client-queues-label">{t('clientPortal.directs', { defaultValue: 'Directs' })}</p>
          <button
            className={`client-queue-item ${activeFilter === 'queue' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveFilter('queue')}
          >
            <span>{t('clientPortal.inQueue', { defaultValue: 'In queue' })}</span>
            <strong>{workspaceChats.length}</strong>
          </button>
          <button
            className={`client-queue-item ${activeFilter === 'inbox' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveFilter('inbox')}
          >
            <span>{t('clientPortal.yourInbox', { defaultValue: 'Your inbox' })}</span>
            <strong>{inboxChats}</strong>
          </button>
          <button
            className={`client-queue-item ${activeFilter === 'groups' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveFilter('groups')}
          >
            <span>{t('clientPortal.groups', { defaultValue: 'Groups' })}</span>
            <strong>{groupChats}</strong>
          </button>
        </div>

        <div className="client-queues-section">
          <p className="client-queues-label">{t('clientPortal.workspace', { defaultValue: 'Workspace' })}</p>
          <div className="client-operator-card">
            <div className="client-operator-row">
              <span>{t('clientPortal.agent', { defaultValue: 'Agent' })}</span>
              <strong>{user.fullName}</strong>
            </div>
            <div className="client-operator-row">
              <span>{t('clientPortal.assignedSessions', { defaultValue: 'Assigned sessions' })}</span>
              <strong>{workspace?.stats.assignedSessions ?? 0}</strong>
            </div>
            <div className="client-operator-row">
              <span>{t('clientPortal.activeSessions', { defaultValue: 'Active sessions' })}</span>
              <strong>{workspace?.stats.activeSessions ?? 0}</strong>
            </div>
            <div className="client-operator-row">
              <span>{t('clientPortal.totalChats', { defaultValue: 'Total chats' })}</span>
              <strong>{workspace?.stats.totalChats ?? 0}</strong>
            </div>
          </div>
        </div>
      </aside>

      <section className="client-inbox-listpane">
        <div className="client-inbox-controls-shell" ref={inboxControlsRef}>
          <header className="client-inbox-heading">
            <div className="client-inbox-heading-copy">
              <strong>{t('clientPortal.yourInbox', { defaultValue: 'Your inbox' })}</strong>
            </div>
            <div className="client-inbox-control-menus">
              <div className="client-inbox-menu-wrap">
                <button
                  className="client-inline-menu-trigger"
                  type="button"
                  onClick={() => {
                    setIsChannelMenuOpen(open => !open);
                    setIsSortMenuOpen(false);
                    setIsStatusMenuOpen(false);
                  }}
                >
                  <span>{channelLabel}</span>
                  <ChevronDown size={14} />
                </button>
                {isChannelMenuOpen && (
                  <div className="client-inline-menu-list client-inline-menu-list-compact">
                    {[
                      ['all', 'All channels'],
                      ['whatsapp', 'WhatsApp'],
                      ['telegram', 'Telegram'],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        className={`client-inline-menu-item ${channelFilter === value ? 'active' : ''}`}
                        type="button"
                        onClick={() => {
                          setChannelFilter(value as ChannelFilter);
                          setIsChannelMenuOpen(false);
                        }}
                      >
                        <strong>{label}</strong>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </header>

          <div className="client-inbox-filterbar">
            <div className="client-inbox-menu-wrap">
              <button
                className="client-inline-filter-trigger"
                type="button"
                onClick={() => {
                  setIsStatusMenuOpen(open => !open);
                  setIsSortMenuOpen(false);
                  setIsChannelMenuOpen(false);
                }}
              >
                <Filter size={15} />
                <span>{inboxStatusLabel}</span>
              </button>
              {isStatusMenuOpen && (
                <div className="client-inline-menu-list">
                  {[
                    ['all', 'All'],
                    ['open', 'Open'],
                    ['closed', 'Closed'],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      className={`client-inline-menu-item ${inboxStatusFilter === value ? 'active' : ''}`}
                      type="button"
                      onClick={() => {
                        setInboxStatusFilter(value as InboxStatusFilter);
                        setIsStatusMenuOpen(false);
                      }}
                    >
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="client-inbox-menu-wrap">
              <button
                className="client-inline-filter-trigger"
                type="button"
                onClick={() => {
                  setIsSortMenuOpen(open => !open);
                  setIsStatusMenuOpen(false);
                  setIsChannelMenuOpen(false);
                }}
              >
                <ArrowUpDown size={15} />
                <span>{inboxSortLabel}</span>
              </button>
              {isSortMenuOpen && (
                <div className="client-inline-menu-list">
                  <p className="client-inline-menu-title">Sort by</p>
                  {[
                    ['latest', 'Latest'],
                    ['oldest', 'Oldest'],
                    ['started_last', 'Started last'],
                    ['started_first', 'Started first'],
                    ['waiting_longest', 'Waiting longest'],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      className={`client-inline-menu-item ${inboxSort === value ? 'active' : ''}`}
                      type="button"
                      onClick={() => {
                        setInboxSort(value as InboxSort);
                        setIsSortMenuOpen(false);
                      }}
                    >
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="client-pane-actions">
              <button
                className="client-refresh-button"
                type="button"
                onClick={() => void handleInboxRefresh()}
                disabled={isRefreshingWorkspace || loadingMessages}
              >
                <RefreshCcw size={16} />
              </button>
            </div>
          </div>
        </div>

        <div className="client-searchbar">
          <Search size={16} />
          <input
            type="search"
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
            placeholder={t('clientPortal.searchPlaceholder', {
              defaultValue: 'Search chats, contacts, or sessions',
            })}
          />
        </div>

        <div className="client-chat-list">
          {filteredChats.length ? (
            filteredChats.map(chat => (
              <button
                key={getChatKey(chat)}
                className={`client-chat-row ${selectedChatKey === getChatKey(chat) ? 'active' : ''}`}
                type="button"
                onClick={() => setSelectedChatKey(getChatKey(chat))}
              >
                <div className="client-chat-avatar">
                  {chat.isGroup ? <Users size={16} /> : <MessageCircleMore size={16} />}
                </div>
                <div className="client-chat-copy">
                  <div className="client-chat-row-top">
                    <strong>{chat.name || chat.id}</strong>
                    <span>{formatChatTime(chat.timestamp)}</span>
                  </div>
                  <p>{chat.lastMessage || 'No recent message available yet.'}</p>
                  <div className="client-chat-meta">
                    <span>
                      {chat.sessionName}
                      {chat.isGroup ? ` • ${t('clientPortal.group', { defaultValue: 'Group' })}` : ''}
                    </span>
                    {chat.unreadCount > 0 && <em>{chat.unreadCount}</em>}
                  </div>
                </div>
              </button>
            ))
          ) : (
            <div className="client-empty-list">
              <MessageCircleMore size={34} />
              <strong>{t('clientPortal.noConversations', { defaultValue: 'No conversations' })}</strong>
            </div>
          )}
        </div>
      </section>

      <section className={`client-conversation-pane ${!activeChat ? 'client-conversation-pane-empty' : ''}`}>
        {activeChat ? (
          <>
            <header className="client-pane-header client-conversation-header">
              <div>
                <h2>{activeChat.name || activeChat.id}</h2>
                <p>
                  {activeChat.sessionName}
                  {activeChat.phoneNumber ? ` • ${activeChat.phoneNumber}` : ''}
                </p>
              </div>
              <div className="client-conversation-badges">
                <span>
                  {activeChat.isGroup
                    ? t('clientPortal.group', { defaultValue: 'Group' })
                    : t('clientPortal.direct', { defaultValue: 'Direct' })}
                </span>
                <span>{formatChatTime(activeChat.timestamp)}</span>
              </div>
            </header>

            {error && <div className="client-login-error">{error}</div>}

            <div className="client-message-stream">
              {loadingMessages ? (
                <div className="client-empty-thread">
                  <strong>{t('clientPortal.loadingMessages', { defaultValue: 'Loading messages...' })}</strong>
                </div>
              ) : messages.length ? (
                messages.map(message => (
                  <article
                    key={message.waMessageId || message.id}
                    className={`client-message-bubble ${message.direction === 'outgoing' ? 'outgoing' : 'incoming'}`}
                  >
                    <p>
                      {message.body || (message.type === 'revoked' ? 'This message was deleted.' : `[${message.type}]`)}
                    </p>
                    <div className="client-message-meta">
                      <span>{formatMessageTime(message.timestamp || message.createdAt)}</span>
                      {message.direction === 'outgoing' && <em>{message.status}</em>}
                    </div>
                  </article>
                ))
              ) : (
                <div className="client-empty-thread">
                  <strong>{t('clientPortal.noMessagesYet', { defaultValue: 'No messages yet' })}</strong>
                  <p>
                    {t('clientPortal.noMessagesYetDesc', {
                      defaultValue:
                        'This conversation is assigned, but there is no stored history to display right now.',
                    })}
                  </p>
                </div>
              )}
            </div>

            <form className="client-composer" onSubmit={handleSend}>
              <textarea
                value={messageInput}
                onChange={event => setMessageInput(event.target.value)}
                placeholder={
                  isOffDuty
                    ? t('clientPortal.offDutyReplyPlaceholder', {
                        defaultValue: 'You are off duty. Turn it on to reply.',
                      })
                    : t('clientPortal.replyPlaceholder', { defaultValue: 'Type your reply here...' })
                }
                rows={3}
                disabled={isOffDuty}
              />
              <button type="submit" disabled={isSending || !messageInput.trim() || isOffDuty}>
                <SendHorizontal size={16} />
                <span>
                  {isSending
                    ? t('clientPortal.sending', { defaultValue: 'Sending...' })
                    : t('clientPortal.send', { defaultValue: 'Send' })}
                </span>
              </button>
            </form>
          </>
        ) : (
          <div className="client-empty-thread client-empty-thread-full">
            <MessageCircleMore size={28} />
            <strong>
              {t('clientPortal.selectConversation', { defaultValue: 'Select a conversation to start chatting' })}
            </strong>
          </div>
        )}
      </section>

      {isProfileModalOpen && (
        <div className="client-profile-modal-backdrop" onClick={() => setIsProfileModalOpen(false)}>
          <div className="client-profile-modal" onClick={event => event.stopPropagation()}>
            <div className="client-profile-modal-header">
              <h3>{t('clientPortal.profile', { defaultValue: 'Profile' })}</h3>
              <button type="button" onClick={() => setIsProfileModalOpen(false)}>
                {t('common.close', { defaultValue: 'Close' })}
              </button>
            </div>
            <form className="client-profile-modal-body" onSubmit={handleProfileSave}>
              <label className="client-profile-field client-profile-field-editable">
                <span>{t('clientPortal.fullName', { defaultValue: 'Full name' })}</span>
                <input
                  type="text"
                  value={profileForm.fullName}
                  onChange={event => setProfileForm(current => ({ ...current, fullName: event.target.value }))}
                />
              </label>
              <div className="client-profile-field">
                <span>{t('clientPortal.email', { defaultValue: 'Email' })}</span>
                <strong>{user.email}</strong>
              </div>
              <div className="client-profile-field">
                <span>{t('common.role', { defaultValue: 'Role' })}</span>
                <strong>{formatRole(user.role)}</strong>
              </div>
              <div className="client-profile-field">
                <span>{t('clientPortal.team', { defaultValue: 'Team' })}</span>
                <strong>{user.teamName ?? t('common.unassigned', { defaultValue: 'Unassigned' })}</strong>
              </div>
              <label className="client-profile-field client-profile-field-editable">
                <span>{t('common.password', { defaultValue: 'Password' })}</span>
                <input
                  type="password"
                  value={profileForm.password}
                  onChange={event => setProfileForm(current => ({ ...current, password: event.target.value }))}
                  placeholder="Enter a new password"
                />
              </label>
              <div className="client-profile-field">
                <span>{t('clientPortal.duty', { defaultValue: 'Duty' })}</span>
                <strong>
                  {isOffDuty
                    ? t('clientPortal.offDuty', { defaultValue: 'Off duty' })
                    : t('clientPortal.available', { defaultValue: 'Available' })}
                </strong>
              </div>
              {profileError && <div className="client-login-error">{profileError}</div>}
              <div className="client-profile-modal-actions">
                <button type="submit" className="client-login-button" disabled={isSavingProfile}>
                  {isSavingProfile
                    ? t('common.save', { defaultValue: 'Saving...' })
                    : t('common.save', { defaultValue: 'Save' })}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
