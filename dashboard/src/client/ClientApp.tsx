import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  MessageCircleMore,
  Moon,
  RefreshCcw,
  Search,
  SendHorizontal,
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
type InboxFilter = 'all' | 'unread' | 'direct' | 'groups';
const OFF_DUTY_STORAGE_KEY = 'aurora_user_off_duty';

function getUserPortalSession() {
  return sessionStorage.getItem('omega_admin_token');
}

function getChatKey(chat: OmegaWorkspaceChat) {
  return `${chat.sessionId}:${chat.id}`;
}

function formatRole(role: string) {
  return role.replace(/_/g, ' ');
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

export function ClientApp({
  standalone = true,
  onLoggedOut,
}: {
  standalone?: boolean;
  onLoggedOut?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const branding = useBranding();
  const { resolvedTheme, toggleTheme } = useTheme();
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
  const [activeFilter, setActiveFilter] = useState<InboxFilter>('all');
  const [selectedChatKey, setSelectedChatKey] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false);
  const [isOffDuty, setIsOffDuty] = useState(() => localStorage.getItem(OFF_DUTY_STORAGE_KEY) === 'true');

  useEffect(() => {
    localStorage.setItem(OFF_DUTY_STORAGE_KEY, String(isOffDuty));
  }, [isOffDuty]);

  const loadWorkspace = useCallback(async (silent = false) => {
    if (!silent) {
      setIsRefreshingWorkspace(true);
    }

    try {
      const currentWorkspace = await omegaWorkspace();
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

    omegaMe()
      .then(async currentUser => {
        setUser(currentUser);
        await loadWorkspace();
      })
      .catch(() => {
        clearOmegaToken();
        setUser(null);
        setWorkspace(null);
        setMessages([]);
        onLoggedOut?.();
      })
      .finally(() => {
        setIsCheckingSession(false);
      });
  }, [loadWorkspace, onLoggedOut, standalone]);

  useEffect(() => {
    if (!user) return;

    const interval = window.setInterval(() => {
      void loadWorkspace(true);
    }, 8000);

    return () => {
      window.clearInterval(interval);
    };
  }, [user, loadWorkspace]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = branding.tabTitle;

    return () => {
      document.title = previousTitle;
    };
  }, [branding.tabTitle]);

  const workspaceChats = workspace?.chats ?? [];

  const filteredChats = useMemo(() => {
    return workspaceChats
      .filter(chat => {
        const matchesSearch =
          chat.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          chat.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
          chat.sessionName.toLowerCase().includes(searchQuery.toLowerCase());

        if (!matchesSearch) return false;
        if (activeFilter === 'unread') return chat.unreadCount > 0;
        if (activeFilter === 'direct') return !chat.isGroup;
        if (activeFilter === 'groups') return chat.isGroup;
        return true;
      })
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }, [activeFilter, searchQuery, workspaceChats]);

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

  const handleSend = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeChat || !messageInput.trim() || isSending || isOffDuty) {
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

  const totalUnread = workspaceChats.reduce((sum, chat) => sum + (chat.unreadCount || 0), 0);
  const directChats = workspaceChats.filter(chat => !chat.isGroup).length;
  const groupChats = workspaceChats.filter(chat => chat.isGroup).length;
  const activeWorkspaceName = workspace?.companyName ?? user?.companyName ?? branding.appName;
  const currentLanguage = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);
  const languageLabel = languageOptions.find(option => option.value === currentLanguage)?.compactLabel ?? 'EN';

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

        <div className="client-language-menu">
          <button
            className="client-rail-action"
            type="button"
            onClick={() => setIsLanguageMenuOpen(open => !open)}
          >
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

        <button className="client-rail-action" type="button" onClick={toggleTheme}>
          <Moon size={18} />
          <span>{resolvedTheme === 'dark' ? t('theme.dark', { defaultValue: 'Dark' }) : t('theme.light', { defaultValue: 'Light' })}</span>
        </button>

        <div className="client-rail-profile-area">
          <div className="client-profile-menu-wrap client-profile-menu-wrap-sidebar">
            <button className="client-profile-trigger" type="button" onClick={() => setIsProfileMenuOpen(open => !open)}>
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
                  <span>{t('clientPortal.offDuty', { defaultValue: 'Off duty' })}</span>
                  <button
                    className={`client-duty-toggle ${isOffDuty ? 'active' : ''}`}
                    type="button"
                    onClick={() => setIsOffDuty(value => !value)}
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
            className={`client-queue-item ${activeFilter === 'all' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveFilter('all')}
          >
            <span>{t('clientPortal.inQueue', { defaultValue: 'In queue' })}</span>
            <strong>{workspaceChats.length}</strong>
          </button>
          <button
            className={`client-queue-item ${activeFilter === 'unread' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveFilter('unread')}
          >
            <span>{t('clientPortal.yourInbox', { defaultValue: 'Your inbox' })}</span>
            <strong>{totalUnread}</strong>
          </button>
          <button
            className={`client-queue-item ${activeFilter === 'direct' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveFilter('direct')}
          >
            <span>{t('clientPortal.directChats', { defaultValue: 'Direct chats' })}</span>
            <strong>{directChats}</strong>
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
        <header className="client-pane-header">
          <div>
            <h1>{t('clientPortal.liveChat', { defaultValue: 'Live chat' })}</h1>
            <p>
              {activeFilter === 'unread'
                ? t('clientPortal.yourInbox', { defaultValue: 'Your inbox' })
                : t('clientPortal.assignedOnly', { defaultValue: 'Assigned conversations only' })}
            </p>
          </div>
          <div className="client-pane-actions">
            <button className="client-refresh-button" type="button" onClick={() => void loadWorkspace()} disabled={isRefreshingWorkspace}>
              <RefreshCcw size={16} />
            </button>
          </div>
        </header>

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

        <div className="client-inbox-toolbar">
          <span>
            {t('clientPortal.conversationsCount', {
              count: filteredChats.length,
              defaultValue: '{{count}} conversations',
            })}
          </span>
          <span>
            {t('clientPortal.activeSessionsCount', {
              count: workspace?.stats.activeSessions ?? 0,
              defaultValue: '{{count}} active WhatsApp sessions',
            })}
          </span>
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
                <div className="client-chat-avatar">{chat.isGroup ? <Users size={16} /> : <MessageCircleMore size={16} />}</div>
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
              <strong>{t('clientPortal.noConversations', { defaultValue: 'No conversations' })}</strong>
              <p>
                {t('clientPortal.noConversationsDesc', {
                  defaultValue: 'Assigned chats will appear here once messages are available for this workspace.',
                })}
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="client-conversation-pane">
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
                    <p>{message.body || (message.type === 'revoked' ? 'This message was deleted.' : `[${message.type}]`)}</p>
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
                      defaultValue: 'This conversation is assigned, but there is no stored history to display right now.',
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
            <p>
              {t('clientPortal.selectConversationDesc', {
                defaultValue: 'Your assigned inbox will appear here, and replies will stay scoped to your workspace only.',
              })}
            </p>
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
            <div className="client-profile-modal-body">
              <div className="client-profile-field">
                <span>{t('clientPortal.fullName', { defaultValue: 'Full name' })}</span>
                <strong>{user.fullName}</strong>
              </div>
              <div className="client-profile-field">
                <span>{t('clientPortal.email', { defaultValue: 'Email' })}</span>
                <strong>{user.email}</strong>
              </div>
              <div className="client-profile-field">
                <span>{t('common.role', { defaultValue: 'Role' })}</span>
                <strong>{formatRole(user.role)}</strong>
              </div>
              <div className="client-profile-field">
                <span>{t('clientPortal.workspace', { defaultValue: 'Workspace' })}</span>
                <strong>{activeWorkspaceName}</strong>
              </div>
              <div className="client-profile-field">
                <span>{t('clientPortal.duty', { defaultValue: 'Duty' })}</span>
                <strong>
                  {isOffDuty
                    ? t('clientPortal.offDuty', { defaultValue: 'Off duty' })
                    : t('clientPortal.available', { defaultValue: 'Available' })}
                </strong>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
