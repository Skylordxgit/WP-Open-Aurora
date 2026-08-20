import { Fragment, useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  Search,
  Send,
  Loader2,
  User,
  Users,
  AlertCircle,
  MessageSquare,
  Paperclip,
  Smile,
  X,
  CornerUpLeft,
  Trash2,
  ChevronDown,
  Funnel,
  ArrowUpDown,
  Phone,
  Wifi,
  Clock3,
  Download,
  FileText,
  Image as ImageIcon,
  MapPin,
  RefreshCw,
  Video,
  Mic,
} from 'lucide-react';
import {
  sessionApi,
  contactApi,
  messageApi,
  asMessageType,
  type Session,
  type Chat,
  type ChatMessage,
  type LiveChatMessage,
  type MessageType,
} from '../services/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../components/Toast';
import './Chats.css';

type MessageMedia = { mimetype: string; filename?: string; data?: string };

interface ChatMessageView extends ChatMessage {
  metadata?: {
    media?: MessageMedia;
    quotedMessage?: { id: string; body: string };
    reactions?: Record<string, string>;
    location?: {
      latitude: number;
      longitude: number;
      description?: string;
      address?: string;
      url?: string;
    };
  };
}

const INITIAL_HISTORY_LIMIT = 100;
const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_LIMIT = 500;

// Delivery acks must only ADVANCE the tick, never regress it. The backend DB update is forward-only
// (ackStatusTransitionFrom), but the live websocket ack fires on every receipt (incl. pending/sent)
// and engine acks can arrive out of order or be replayed on reconnect — so a late/duplicate lower
// ack must not visually downgrade a row already shown as delivered/read. This mirrors the backend's
// transition rules exactly: pending<sent<delivered<read advances by rank; `failed` only applies from
// pending/sent (a late failure must not clobber a confirmed delivered/read), and is terminal once set.
const DELIVERY_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };
const mergeDeliveryStatus = (
  current: ChatMessageView['status'] | undefined,
  incoming: ChatMessageView['status'] | undefined,
): ChatMessageView['status'] | undefined => {
  if (!incoming) return current;
  if (!current) return incoming;
  if (current === 'failed') return 'failed'; // terminal — nothing advances from failed
  if (incoming === 'failed') return current === 'pending' || current === 'sent' ? 'failed' : current;
  if (!(incoming in DELIVERY_RANK)) return current; // unknown status — ignore
  if (!(current in DELIVERY_RANK)) return incoming;
  return DELIVERY_RANK[incoming] >= DELIVERY_RANK[current] ? incoming : current;
};

interface IncomingWsMessage {
  id: string;
  chatId: string;
  from: string;
  to: string;
  body: string;
  type: string;
  timestamp: number;
  fromMe?: boolean;
  media?: MessageMedia;
  quotedMessage?: { id: string; body: string };
  metadata?: ChatMessageView['metadata'];
}

// Map an attachment MIME type to the neutral MessageType for the optimistic outgoing bubble, so the
// placeholder matches what the backend will persist (e.g. a PDF is `document`, not `application`).
const messageTypeFromMime = (mimetype: string): MessageType => {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
};

const getMediaSrc = (media?: MessageMedia): string => {
  if (!media || !media.data) return '';
  if (media.data.startsWith('data:') || media.data.startsWith('http://') || media.data.startsWith('https://')) {
    return media.data;
  }
  return `data:${media.mimetype};base64,${media.data}`;
};

const getChatNumber = (chatId: string): string => chatId.split('@')[0];

const getChatDisplayName = (chat: Pick<Chat, 'id' | 'name' | 'displayName' | 'phone'>): string => {
  const resolvedName = chat.displayName?.trim();
  if (resolvedName) return resolvedName;

  const trimmedName = chat.name?.trim();
  if (trimmedName && !trimmedName.includes('@')) {
    return trimmedName;
  }

  if (chat.phone?.trim()) return chat.phone.trim();
  if (chat.id.endsWith('@lid')) return 'Number unavailable';
  return getChatNumber(chat.id);
};

const loadStoredMessageHistory = async (sessionId: string, chatId: string, limit: number) => {
  const messages: ChatMessage[] = [];
  let total = 0;

  for (let offset = 0; offset < limit; offset += INITIAL_HISTORY_LIMIT) {
    const page = await sessionApi.getChatMessages(sessionId, chatId, INITIAL_HISTORY_LIMIT, offset);
    messages.push(...page.messages);
    total = page.total;
    if (page.messages.length === 0 || messages.length >= total) break;
  }

  return { messages: messages.slice(0, limit), total };
};

const messageIdentity = (message: ChatMessageView): string => message.waMessageId || message.id;

const messageTimestamp = (message: ChatMessageView): number => {
  if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    return message.timestamp;
  }
  const createdAt = new Date(message.createdAt).getTime();
  return Number.isFinite(createdAt) ? Math.floor(createdAt / 1000) : 0;
};

const normalizeLiveMessage = (message: LiveChatMessage): ChatMessageView => {
  const metadata: ChatMessageView['metadata'] = {};
  if (message.media) metadata.media = message.media;
  if (message.quotedMessage) metadata.quotedMessage = message.quotedMessage;
  if (message.location) metadata.location = message.location;

  return {
    id: message.id,
    waMessageId: message.id,
    chatId: message.chatId,
    from: message.from,
    to: message.to,
    body: message.body || '',
    type: asMessageType(message.type),
    direction: message.fromMe ? 'outgoing' : 'incoming',
    status: 'sent',
    timestamp: message.timestamp,
    createdAt: new Date(message.timestamp * 1000).toISOString(),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
};

const isRenderableMessage = (message: ChatMessageView): boolean => {
  if (message.type === 'revoked') return true;
  if (message.body?.trim()) return true;
  if (message.metadata?.quotedMessage?.body?.trim()) return true;
  if (message.type === 'location' && message.metadata?.location) return true;
  return ['image', 'sticker', 'video', 'audio', 'voice', 'document'].includes(message.type);
};

const mergeMessageHistory = (...collections: ChatMessageView[][]): ChatMessageView[] => {
  const merged = new Map<string, ChatMessageView>();

  for (const collection of collections) {
    for (const message of collection) {
      const key = messageIdentity(message);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, message);
        continue;
      }

      const existingMedia = existing.metadata?.media;
      const incomingMedia = message.metadata?.media;
      const media = incomingMedia?.data
        ? incomingMedia
        : existingMedia?.data
          ? existingMedia
          : incomingMedia || existingMedia;
      const metadata = {
        ...existing.metadata,
        ...message.metadata,
        ...(media ? { media } : {}),
      };

      merged.set(key, {
        ...existing,
        ...message,
        body: message.body?.trim() ? message.body : existing.body,
        type: message.type === 'unknown' && existing.type !== 'unknown' ? existing.type : message.type,
        status: mergeDeliveryStatus(existing.status, message.status) || message.status,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    }
  }

  return [...merged.values()].filter(isRenderableMessage).sort((a, b) => messageTimestamp(a) - messageTimestamp(b));
};

export function Chats() {
  const { t } = useTranslation();
  useDocumentTitle(t('nav.chats'));
  const { canWrite } = useRole();
  const { error: showErrorToast, warning: showWarningToast } = useToast();

  // Sessions list & active session
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [loadingSessions, setLoadingSessions] = useState<boolean>(true);

  // Chats list
  const [chats, setChats] = useState<Chat[]>([]);
  const [loadingChats, setLoadingChats] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [inboxView, setInboxView] = useState<'all' | 'unread' | 'direct' | 'groups'>('all');
  const [sortMode, setSortMode] = useState<'recent' | 'oldest'>('recent');

  // Selected chat & message history
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [loadingMessages, setLoadingMessages] = useState<boolean>(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState<boolean>(false);
  const [loadingMedia, setLoadingMedia] = useState<boolean>(false);
  const [historyLimit, setHistoryLimit] = useState<number>(INITIAL_HISTORY_LIMIT);
  const [canLoadOlder, setCanLoadOlder] = useState<boolean>(false);
  const [historySource, setHistorySource] = useState<'live' | 'stored'>('live');
  const [messageInput, setMessageInput] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);

  // File attachments
  const [attachment, setAttachment] = useState<{
    file: File;
    base64: string;
    mimetype: string;
    filename: string;
  } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState<boolean>(false);

  // References
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const roomMessagesRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messageRequestRef = useRef(0);
  const contactResolutionRequestRef = useRef(0);
  const contactResolutionInFlightRef = useRef<string | null>(null);
  const shouldScrollToBottomRef = useRef(false);
  const preservedScrollRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);
  const activeChatId = activeChat?.id;
  const selectedSession = sessions.find(session => session.id === selectedSessionId) || null;
  const isSessionReady = selectedSession?.status === 'ready';

  // Popular emojis
  const popularEmojis = [
    '😀',
    '😂',
    '👍',
    '❤️',
    '🔥',
    '👏',
    '🙏',
    '🎉',
    '💡',
    '🤔',
    '😅',
    '😍',
    '😊',
    '😭',
    '😎',
    '😜',
    '🚀',
    '✨',
  ];

  // 1. Fetch available connected sessions on mount
  useEffect(() => {
    const loadSessions = async () => {
      try {
        setLoadingSessions(true);
        const list = await sessionApi.list();
        const readySessions = list.filter(s => s.status === 'ready');
        setSessions(readySessions);
        if (readySessions.length > 0) {
          setSelectedSessionId(readySessions[0].id);
        }
      } catch (err) {
        showErrorToast(t('chats.errors.loadSessions'), err instanceof Error ? err.message : undefined);
      } finally {
        setLoadingSessions(false);
      }
    };
    void loadSessions();
  }, [t, showErrorToast]);

  // 2. Fetch chats when active session changes
  const loadChats = useCallback(
    async (sessionId: string) => {
      if (!sessionId) return;
      const resolutionRequestId = ++contactResolutionRequestRef.current;
      try {
        setLoadingChats(true);
        const data = await sessionApi.getChats(sessionId);
        const sorted = [...data].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        setChats(sorted);

        const privacyContactIds = sorted.filter(chat => !chat.isGroup && chat.id.endsWith('@lid')).map(chat => chat.id);
        if (privacyContactIds.length > 0 && !contactResolutionInFlightRef.current) {
          contactResolutionInFlightRef.current = sessionId;
          void contactApi
            .resolve(sessionId, privacyContactIds)
            .then(resolvedContacts => {
              if (resolutionRequestId !== contactResolutionRequestRef.current) return;
              const resolvedById = new Map(resolvedContacts.map(contact => [contact.contactId, contact]));
              const enrichChat = (chat: Chat): Chat => {
                const resolved = resolvedById.get(chat.id);
                if (!resolved?.phone && !resolved?.name) return chat;
                return {
                  ...chat,
                  displayName: resolved.name || resolved.phone || undefined,
                  phone: resolved.phone || undefined,
                };
              };
              setChats(current => current.map(enrichChat));
              setActiveChat(current => (current ? enrichChat(current) : current));
            })
            .catch(() => {
              // A background retry below runs after the WhatsApp session finishes synchronizing.
            })
            .finally(() => {
              if (contactResolutionInFlightRef.current === sessionId) {
                contactResolutionInFlightRef.current = null;
              }
            });
        }
      } catch (err) {
        showErrorToast(t('chats.errors.loadChats'), err instanceof Error ? err.message : undefined);
        setChats([]);
      } finally {
        setLoadingChats(false);
      }
    },
    [t, showErrorToast],
  );

  useEffect(() => {
    if (selectedSessionId) {
      void loadChats(selectedSessionId);
      setActiveChat(null);
      setMessages([]);
      setAttachment(null);
      setPreviewUrl(null);
    }
  }, [selectedSessionId, loadChats]);

  // The initial chat list can come from the database while WhatsApp is reconnecting. Retry unresolved
  // privacy contacts after sync instead of permanently keeping the result of that first attempt.
  const unresolvedPrivacyContactKey = chats
    .filter(chat => !chat.isGroup && chat.id.endsWith('@lid') && !chat.phone && !chat.displayName)
    .map(chat => chat.id)
    .join('|');

  useEffect(() => {
    const unresolvedIds = unresolvedPrivacyContactKey.split('|').filter(Boolean);
    if (!selectedSessionId || unresolvedIds.length === 0) return;

    let cancelled = false;
    let retryTimer: number | undefined;
    let attempts = 0;

    const resolveUnresolvedContacts = async () => {
      if (cancelled) return;
      if (contactResolutionInFlightRef.current) {
        retryTimer = window.setTimeout(resolveUnresolvedContacts, 3000);
        return;
      }
      contactResolutionInFlightRef.current = selectedSessionId;
      try {
        const resolvedContacts = await contactApi.resolve(selectedSessionId, unresolvedIds);
        if (cancelled) return;
        if (!resolvedContacts.some(contact => contact.phone || contact.name)) return;
        const resolvedById = new Map(resolvedContacts.map(contact => [contact.contactId, contact]));
        const enrichChat = (chat: Chat): Chat => {
          const resolved = resolvedById.get(chat.id);
          if (!resolved?.phone && !resolved?.name) return chat;
          return {
            ...chat,
            displayName: resolved.name || resolved.phone || undefined,
            phone: resolved.phone || undefined,
          };
        };
        setChats(current => current.map(enrichChat));
        setActiveChat(current => (current ? enrichChat(current) : current));
      } catch {
        // A 503 is expected until the scanned WhatsApp session reaches READY.
      } finally {
        if (contactResolutionInFlightRef.current === selectedSessionId) {
          contactResolutionInFlightRef.current = null;
        }
        attempts += 1;
        if (!cancelled && attempts < 12) {
          retryTimer = window.setTimeout(resolveUnresolvedContacts, 10000);
        }
      }
    };

    retryTimer = window.setTimeout(resolveUnresolvedContacts, 3000);
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [selectedSessionId, unresolvedPrivacyContactKey]);

  const markChatRead = useCallback(
    (chatId: string) => {
      void sessionApi.markChatRead(selectedSessionId, chatId).catch(err => {
        showWarningToast(t('chats.errors.markRead'), err instanceof Error ? err.message : undefined);
      });
    },
    [selectedSessionId, t, showWarningToast],
  );

  const isRoomNearBottom = useCallback(() => {
    const room = roomMessagesRef.current;
    if (!room) return true;
    return room.scrollHeight - room.scrollTop - room.clientHeight < 120;
  }, []);

  // 3. WebSocket integration for real-time messages
  const handleIncomingMessage = useCallback(
    (event: { sessionId: string; message: Record<string, unknown> }) => {
      if (event.sessionId !== selectedSessionId) return;

      const newMsg = event.message as unknown as IncomingWsMessage;

      // Update message list if the message belongs to the currently active chat
      if (activeChat && newMsg.chatId === activeChat.id) {
        markChatRead(activeChat.id);
        shouldScrollToBottomRef.current = isRoomNearBottom();

        const mappedMessage: ChatMessageView = {
          id: newMsg.id,
          waMessageId: newMsg.id,
          chatId: newMsg.chatId,
          from: newMsg.from,
          to: newMsg.to,
          body: newMsg.body,
          type: asMessageType(newMsg.type),
          direction: newMsg.fromMe ? 'outgoing' : 'incoming',
          status: 'sent',
          timestamp: newMsg.timestamp,
          createdAt: new Date(newMsg.timestamp * 1000).toISOString(),
          metadata: newMsg.metadata || {
            media: newMsg.media,
            quotedMessage: newMsg.quotedMessage,
          },
        };

        setMessages(prev => {
          if (prev.some(m => m.id === mappedMessage.id || m.waMessageId === mappedMessage.id)) {
            return prev;
          }
          return [...prev, mappedMessage];
        });
      }

      // Update sidebar chat list
      setChats(prevChats => {
        const chatIndex = prevChats.findIndex(c => c.id === newMsg.chatId);
        if (chatIndex === -1) {
          void loadChats(selectedSessionId);
          return prevChats;
        }

        const updatedChats = [...prevChats];
        const targetChat = { ...updatedChats[chatIndex] };
        targetChat.lastMessage = newMsg.body;
        targetChat.timestamp = newMsg.timestamp;

        if (!newMsg.fromMe && (!activeChat || activeChat.id !== targetChat.id)) {
          targetChat.unreadCount = (targetChat.unreadCount || 0) + 1;
        }

        updatedChats.splice(chatIndex, 1);
        updatedChats.unshift(targetChat);
        return updatedChats;
      });
    },
    [selectedSessionId, activeChat, loadChats, markChatRead, isRoomNearBottom],
  );

  const handleIncomingMessageAck = useCallback(
    (event: { sessionId: string; messageId: string; status: ChatMessageView['status'] }) => {
      if (event.sessionId !== selectedSessionId) return;

      setMessages(prev =>
        prev.map(msg => {
          if (msg.id === event.messageId || msg.waMessageId === event.messageId) {
            // Backend now sends the neutral delivery status directly (no engine-specific ack codes).
            // Merge forward-only so an out-of-order/replayed lower ack can't downgrade the tick.
            return { ...msg, status: mergeDeliveryStatus(msg.status, event.status) ?? msg.status };
          }
          return msg;
        }),
      );
    },
    [selectedSessionId],
  );

  const handleIncomingMessageReaction = useCallback(
    (event: { sessionId: string; messageId: string; reactions: Record<string, string> }) => {
      if (event.sessionId !== selectedSessionId) return;

      setMessages(prev =>
        prev.map(msg => {
          if (msg.id === event.messageId || msg.waMessageId === event.messageId) {
            const metadata = msg.metadata || {};
            return { ...msg, metadata: { ...metadata, reactions: event.reactions } };
          }
          return msg;
        }),
      );
    },
    [selectedSessionId],
  );

  const handleIncomingMessageRevoked = useCallback(
    (event: { sessionId: string; id: string; type: string }) => {
      if (event.sessionId !== selectedSessionId) return;

      setMessages(prev =>
        prev.map(msg => {
          if (msg.id === event.id || msg.waMessageId === event.id) {
            // The backend emits an empty body; the localized "deleted" label is rendered below.
            return { ...msg, body: '', type: asMessageType(event.type) };
          }
          return msg;
        }),
      );
    },
    [selectedSessionId],
  );

  const handleSessionStatus = useCallback((event: { sessionId: string; status: string }) => {
    setSessions(current =>
      current.map(session =>
        session.id === event.sessionId ? { ...session, status: event.status as Session['status'] } : session,
      ),
    );
  }, []);

  const { isConnected, connectionFailed, reconnect, subscribe, unsubscribe } = useWebSocket({
    onSessionStatus: handleSessionStatus,
    onMessage: handleIncomingMessage,
    onMessageAck: handleIncomingMessageAck,
    onMessageReaction: handleIncomingMessageReaction,
    onMessageRevoked: handleIncomingMessageRevoked,
  });

  useEffect(() => {
    if (selectedSessionId && isConnected) {
      subscribe(selectedSessionId, [
        'message.received',
        'message.sent',
        'message.ack',
        'message.reaction',
        'message.revoked',
        'session.status',
      ]);
      return () => {
        unsubscribe(selectedSessionId);
      };
    }
  }, [selectedSessionId, isConnected, subscribe, unsubscribe]);

  // Keep readiness accurate even when Socket.IO is reconnecting. This prevents a stale READY badge
  // from allowing sends after the WhatsApp engine has dropped, and recovers without a page refresh.
  useEffect(() => {
    if (!selectedSessionId) return;
    let cancelled = false;

    const refreshSession = async () => {
      try {
        const updated = await sessionApi.get(selectedSessionId);
        if (!cancelled) {
          setSessions(current => current.map(session => (session.id === updated.id ? updated : session)));
        }
      } catch {
        // The existing API/session error surfaces remain authoritative; retry on the next interval.
      }
    };

    void refreshSession();
    const interval = window.setInterval(refreshSession, isConnected ? 15000 : 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [isConnected, selectedSessionId]);

  // 4. Merge live WhatsApp history with locally stored delivery state. Text arrives first so the
  // conversation is usable immediately; media is hydrated in a second request in the background.
  const loadMessages = useCallback(
    async (chatId: string, limit = INITIAL_HISTORY_LIMIT, loadingOlder = false) => {
      if (!selectedSessionId || !chatId) return;
      const requestId = ++messageRequestRef.current;
      setLoadingMedia(false);
      try {
        if (loadingOlder) {
          setLoadingOlderMessages(true);
        } else {
          setLoadingMessages(true);
          setLoadingMedia(false);
          setCanLoadOlder(false);
          setHistoryLimit(limit);
          shouldScrollToBottomRef.current = true;
          markChatRead(chatId);
        }

        const [storedResult, liveResult] = await Promise.allSettled([
          loadStoredMessageHistory(selectedSessionId, chatId, limit),
          sessionApi.getLiveChatHistory(selectedSessionId, chatId, limit, false),
        ]);

        if (requestId !== messageRequestRef.current) return;
        if (storedResult.status === 'rejected' && liveResult.status === 'rejected') {
          throw liveResult.reason;
        }

        const storedMessages =
          storedResult.status === 'fulfilled' ? ([...storedResult.value.messages].reverse() as ChatMessageView[]) : [];
        const liveMessages = liveResult.status === 'fulfilled' ? liveResult.value.map(normalizeLiveMessage) : [];
        const loadedMessages = mergeMessageHistory(liveMessages, storedMessages);

        setMessages(previous => (loadingOlder ? mergeMessageHistory(previous, loadedMessages) : loadedMessages));
        setHistoryLimit(limit);
        setHistorySource(liveResult.status === 'fulfilled' ? 'live' : 'stored');
        setCanLoadOlder(
          limit < MAX_HISTORY_LIMIT &&
            ((liveResult.status === 'fulfilled' && liveResult.value.length >= limit) ||
              (storedResult.status === 'fulfilled' && storedResult.value.total > limit)),
        );

        if (liveResult.status === 'fulfilled') {
          setLoadingMedia(true);
          void sessionApi
            .getLiveChatHistory(selectedSessionId, chatId, limit, true)
            .then(mediaHistory => {
              if (requestId !== messageRequestRef.current) return;
              setMessages(previous => mergeMessageHistory(previous, mediaHistory.map(normalizeLiveMessage)));
            })
            .catch(() => {
              // Expired or unavailable WhatsApp media is represented by a clear placeholder below.
            })
            .finally(() => {
              if (requestId === messageRequestRef.current) setLoadingMedia(false);
            });
        }
      } catch (err) {
        if (requestId !== messageRequestRef.current) return;
        if (loadingOlder) preservedScrollRef.current = null;
        showErrorToast(t('chats.errors.loadMessages'), err instanceof Error ? err.message : undefined);
        if (!loadingOlder) setMessages([]);
      } finally {
        if (requestId === messageRequestRef.current) {
          setLoadingMessages(false);
          setLoadingOlderMessages(false);
        }
      }
    },
    [selectedSessionId, markChatRead, t, showErrorToast],
  );

  // A stored-only result usually means the chat was opened before the WhatsApp engine finished
  // reconnecting. Recover the live history automatically so old incoming and outgoing messages appear
  // without requiring the operator to refresh or reselect the conversation.
  useEffect(() => {
    if (!selectedSessionId || !activeChatId || historySource !== 'stored') return;

    let cancelled = false;
    let retryTimer: number | undefined;
    let attempts = 0;

    const recoverLiveHistory = async () => {
      if (cancelled) return;
      try {
        const liveHistory = await sessionApi.getLiveChatHistory(selectedSessionId, activeChatId, historyLimit, false);
        if (cancelled) return;
        const normalized = liveHistory.map(normalizeLiveMessage).filter(isRenderableMessage);
        if (normalized.length === 0 && messages.length > 0) {
          throw new Error('WhatsApp history is not synchronized yet');
        }

        setMessages(previous => mergeMessageHistory(previous, normalized));
        setHistorySource('live');
        setCanLoadOlder(historyLimit < MAX_HISTORY_LIMIT && liveHistory.length >= historyLimit);
        setLoadingMedia(true);
        void sessionApi
          .getLiveChatHistory(selectedSessionId, activeChatId, historyLimit, true)
          .then(mediaHistory => {
            if (!cancelled) {
              setMessages(previous => mergeMessageHistory(previous, mediaHistory.map(normalizeLiveMessage)));
            }
          })
          .catch(() => undefined)
          .finally(() => {
            if (!cancelled) setLoadingMedia(false);
          });
      } catch {
        attempts += 1;
        if (!cancelled && attempts < 12) {
          retryTimer = window.setTimeout(recoverLiveHistory, 10000);
        }
      }
    };

    retryTimer = window.setTimeout(recoverLiveHistory, 3000);
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [activeChatId, historyLimit, historySource, messages.length, selectedSessionId]);

  const handleLoadOlderMessages = () => {
    if (!activeChat || loadingOlderMessages) return;
    const room = roomMessagesRef.current;
    if (room) {
      preservedScrollRef.current = { scrollHeight: room.scrollHeight, scrollTop: room.scrollTop };
    }
    const nextLimit = Math.min(historyLimit + HISTORY_PAGE_SIZE, MAX_HISTORY_LIMIT);
    void loadMessages(activeChat.id, nextLimit, true);
  };

  const handleReactMessage = async (msg: ChatMessageView, emoji: string) => {
    if (!selectedSessionId || !activeChat) return;

    const msgId = msg.waMessageId || msg.id;
    const currentReactions = msg.metadata?.reactions || {};
    const sessionPhone = sessions.find(s => s.id === selectedSessionId)?.phone || 'me';

    let alreadyReacted = false;
    for (const [sender, emo] of Object.entries(currentReactions)) {
      if ((sender === 'me' || sender.includes(sessionPhone)) && emo === emoji) {
        alreadyReacted = true;
        break;
      }
    }

    const emojiToSend = alreadyReacted ? '' : emoji;

    try {
      await messageApi.react(selectedSessionId, {
        chatId: activeChat.id,
        messageId: msgId,
        emoji: emojiToSend,
      });

      setMessages(prev =>
        prev.map(m => {
          if (m.id === msg.id || m.waMessageId === msg.id) {
            const metadata = m.metadata || {};
            const reactions = { ...(metadata.reactions || {}) };
            if (emojiToSend === '') {
              delete reactions['me'];
            } else {
              reactions['me'] = emojiToSend;
            }
            return { ...m, metadata: { ...metadata, reactions } };
          }
          return m;
        }),
      );
    } catch (err) {
      showErrorToast(t('chats.errors.react'), err instanceof Error ? err.message : undefined);
    }
  };

  const handleDeleteMessage = async (msg: ChatMessageView) => {
    if (!selectedSessionId || !activeChat) return;
    const msgId = msg.waMessageId || msg.id;

    if (!window.confirm(t('chats.deleteConfirm'))) return;

    try {
      await messageApi.delete(selectedSessionId, {
        chatId: activeChat.id,
        messageId: msgId,
        forEveryone: true,
      });

      setMessages(prev =>
        prev.map(m => {
          if (m.id === msg.id || m.waMessageId === msg.id) {
            return { ...m, body: '', type: 'revoked' };
          }
          return m;
        }),
      );
    } catch (err) {
      showErrorToast(t('chats.errors.delete'), err instanceof Error ? err.message : undefined);
    }
  };

  useEffect(() => {
    if (activeChatId) {
      setHistoryLimit(INITIAL_HISTORY_LIMIT);
      setCanLoadOlder(false);
      setHistorySource('live');
      preservedScrollRef.current = null;
      void loadMessages(activeChatId, INITIAL_HISTORY_LIMIT);
      setChats(prev => prev.map(c => (c.id === activeChatId ? { ...c, unreadCount: 0 } : c)));
    } else {
      messageRequestRef.current += 1;
      setMessages([]);
      setLoadingMessages(false);
      setLoadingOlderMessages(false);
      setLoadingMedia(false);
    }
  }, [activeChatId, loadMessages]);

  // 5. Keep the viewport stable while prepending history, and only follow new messages when the
  // operator was already near the bottom (or just sent a message).
  useLayoutEffect(() => {
    const room = roomMessagesRef.current;
    if (!room) return;

    const preserved = preservedScrollRef.current;
    if (preserved) {
      room.scrollTop = room.scrollHeight - preserved.scrollHeight + preserved.scrollTop;
      preservedScrollRef.current = null;
      return;
    }

    if (shouldScrollToBottomRef.current) {
      chatBottomRef.current?.scrollIntoView({ block: 'end' });
      shouldScrollToBottomRef.current = false;
    }
  }, [messages]);

  // 6. Handle file selection & base64 conversion
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type.startsWith('image/')) {
      setPreviewUrl(URL.createObjectURL(file));
    } else {
      setPreviewUrl(null);
    }

    const reader = new FileReader();
    reader.onload = event => {
      const dataUrl = event.target?.result as string;
      const base64Data = dataUrl.split(',')[1];
      setAttachment({ file, base64: base64Data, mimetype: file.type, filename: file.name });
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveAttachment = () => {
    setAttachment(null);
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  const handleEmojiClick = (emoji: string) => {
    setMessageInput(prev => prev + emoji);
    setShowEmojiPicker(false);
  };

  // 7. Handle sending a message / media
  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedSessionId || !activeChat || sending) return;
    if (!isSessionReady) {
      showWarningToast('WhatsApp is still synchronizing', 'Please wait for the session to reconnect before sending.');
      return;
    }

    const textToSend = messageInput.trim();
    if (!textToSend && !attachment) return;

    setMessageInput('');
    setSending(true);

    const tempId = `temp_${Date.now()}`;
    const tempMessage: ChatMessageView = {
      id: tempId,
      chatId: activeChat.id,
      from: 'me',
      to: activeChat.id,
      body: attachment
        ? attachment.mimetype.startsWith('image/') ||
          attachment.mimetype.startsWith('video/') ||
          attachment.mimetype.startsWith('audio/')
          ? textToSend
          : attachment.filename
        : textToSend,
      type: attachment ? messageTypeFromMime(attachment.mimetype) : 'text',
      direction: 'outgoing',
      status: 'pending',
      createdAt: new Date().toISOString(),
      metadata: attachment
        ? {
            media: {
              mimetype: attachment.mimetype,
              filename: attachment.filename,
              data: attachment.base64,
            },
          }
        : replyingTo
          ? {
              quotedMessage: {
                id: replyingTo.waMessageId || replyingTo.id,
                body: replyingTo.type !== 'text' ? `[${replyingTo.type}]` : replyingTo.body,
              },
            }
          : undefined,
    };

    shouldScrollToBottomRef.current = true;
    setMessages(prev => [...prev, tempMessage]);

    const currentAttachment = attachment;
    const currentReplyingTo = replyingTo;
    handleRemoveAttachment();
    setReplyingTo(null);

    try {
      let result;

      if (currentAttachment) {
        let mediaType: 'image' | 'video' | 'audio' | 'document' = 'document';
        const mime = currentAttachment.mimetype;
        if (mime.startsWith('image/')) mediaType = 'image';
        else if (mime.startsWith('video/')) mediaType = 'video';
        else if (mime.startsWith('audio/')) mediaType = 'audio';

        result = await messageApi.sendMedia(selectedSessionId, activeChat.id, mediaType, {
          base64: currentAttachment.base64,
          mimetype: currentAttachment.mimetype,
          filename: currentAttachment.filename,
          caption: mediaType !== 'audio' ? textToSend : undefined,
        });
      } else if (currentReplyingTo) {
        result = await messageApi.reply(selectedSessionId, {
          chatId: activeChat.id,
          quotedMessageId: currentReplyingTo.waMessageId || currentReplyingTo.id,
          text: textToSend,
        });
      } else {
        result = await messageApi.sendText(selectedSessionId, activeChat.id, textToSend);
      }

      setMessages(prev => {
        // Race guard: the realtime `message.sent` echo can arrive before this response and already
        // append the message by its real WA id (the dedup at receive time misses because the
        // optimistic placeholder still carries the temp id). If so, drop the placeholder instead of
        // renaming it — otherwise both the echo and the renamed temp render as duplicate bubbles.
        const echoAlreadyAdded = prev.some(m => m.id === result.messageId || m.waMessageId === result.messageId);
        if (echoAlreadyAdded) {
          return prev.filter(m => m.id !== tempId);
        }
        return prev.map(m =>
          m.id === tempId ? { ...m, id: result.messageId, waMessageId: result.messageId, status: 'sent' } : m,
        );
      });

      // Update sidebar chat list (move active chat to the top with the new snippet)
      setChats(prevChats => {
        const chatIndex = prevChats.findIndex(c => c.id === activeChat.id);
        if (chatIndex === -1) return prevChats;
        const updatedChats = [...prevChats];
        const target = { ...updatedChats[chatIndex] };
        target.lastMessage = currentAttachment ? `[${currentAttachment.mimetype.split('/')[0]}]` : textToSend;
        target.timestamp = Math.floor(Date.now() / 1000);
        updatedChats.splice(chatIndex, 1);
        updatedChats.unshift(target);
        return updatedChats;
      });
    } catch (err) {
      showErrorToast(t('chats.errors.send'), err instanceof Error ? err.message : undefined);
      setMessages(prev => prev.map(m => (m.id === tempId ? { ...m, status: 'failed' } : m)));
      if (currentAttachment) {
        setAttachment(currentAttachment);
        if (currentAttachment.mimetype.startsWith('image/')) {
          setPreviewUrl(URL.createObjectURL(currentAttachment.file));
        }
      } else {
        setMessageInput(current => current || textToSend);
      }
      if (currentReplyingTo) setReplyingTo(currentReplyingTo);
    } finally {
      setSending(false);
    }
  };

  // Helper formats
  const formatTime = (timestamp?: number) => {
    if (!timestamp) return '';
    return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatMessageDate = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return 'Today';

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return t('chats.yesterday');

    return date.toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
    });
  };

  const formatLastMessageSnippet = (chat: Chat) => chat.lastMessage || '';
  const totalUnread = chats.reduce((sum, chat) => sum + (chat.unreadCount || 0), 0);
  const directChats = chats.filter(chat => !chat.isGroup).length;
  const groupChats = chats.filter(chat => chat.isGroup).length;
  const activeChatMessageCount = messages.length;
  const activeChatUnread = activeChat?.unreadCount || 0;

  const formatChatTime = (timestamp?: number) => {
    if (!timestamp) return '';
    const date = new Date(timestamp * 1000);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return t('chats.yesterday');
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const filteredChats = chats
    .filter(chat => {
      const matchesSearch =
        chat.displayName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        chat.phone?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        chat.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        chat.id.toLowerCase().includes(searchQuery.toLowerCase());

      if (!matchesSearch) return false;
      if (inboxView === 'unread') return (chat.unreadCount || 0) > 0;
      if (inboxView === 'direct') return !chat.isGroup;
      if (inboxView === 'groups') return chat.isGroup;
      return true;
    })
    .sort((a, b) => {
      const aTime = a.timestamp || 0;
      const bTime = b.timestamp || 0;
      return sortMode === 'recent' ? bTime - aTime : aTime - bTime;
    });

  const inboxTitle =
    inboxView === 'unread'
      ? 'Unread queue'
      : inboxView === 'direct'
        ? 'Direct conversations'
        : inboxView === 'groups'
          ? 'Group conversations'
          : selectedSession?.name || 'Inbox';

  const inboxSubtitle =
    inboxView === 'unread'
      ? `${totalUnread} unread messages waiting for action`
      : `${filteredChats.length} conversations available in this workspace`;

  return (
    <div className="chats-page">
      {/* Real-time connection permanently dropped — let the user re-establish it instead of
          silently showing stale chats. */}
      {connectionFailed && (
        <div className="chats-reconnect-banner" role="alert">
          <AlertCircle size={16} />
          <span>{t('common.disconnected')}</span>
          <button className="btn-secondary" onClick={reconnect}>
            {t('common.refresh')}
          </button>
        </div>
      )}

      {loadingSessions ? (
        <div className="chats-loading-container">
          <Loader2 className="animate-spin" size={32} />
          <p>{t('common.loading')}</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="chats-error-state">
          <AlertCircle size={48} className="text-warn" />
          <h3>{t('chats.noSessionsTitle')}</h3>
          <p>
            <Trans i18nKey="chats.noSessionsDesc">
              Please connect a WhatsApp session from the <strong>Sessions</strong> menu first to use the chat feature.
            </Trans>
          </p>
        </div>
      ) : (
        <div className="chats-layout">
          <aside className="chats-rail">
            <div className="chats-rail-brand">
              <div className="chats-rail-brand-icon">
                <MessageSquare size={18} />
              </div>
              <div>
                <div className="chats-rail-brand-title">Help Desk</div>
                <div className="chats-rail-brand-subtitle">WhatsApp operator workspace</div>
              </div>
            </div>

            <div className="chats-rail-group">
              <div className="chats-rail-label">Active session</div>
              <div className="chats-rail-card">
                <div className="chats-rail-card-top">
                  <div>
                    <div className="chats-rail-card-title">{selectedSession?.name || 'Session'}</div>
                    <div className="chats-rail-card-subtitle">{selectedSession?.phone || t('chats.noPhone')}</div>
                  </div>
                  <span className={`chats-session-badge ${isSessionReady ? 'online' : 'syncing'}`}>
                    <Wifi size={12} />
                    {isSessionReady ? 'Live' : 'Syncing'}
                  </span>
                </div>
                <select
                  value={selectedSessionId}
                  onChange={e => setSelectedSessionId(e.target.value)}
                  className="session-selector"
                >
                  {sessions.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.phone || t('chats.noPhone')})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="chats-rail-group">
              <div className="chats-rail-label">Views</div>
              <div className="chats-rail-nav">
                <button
                  type="button"
                  className={`chats-rail-nav-item ${inboxView === 'all' ? 'active' : ''}`}
                  onClick={() => setInboxView('all')}
                >
                  <span className="chats-rail-nav-main">
                    <MessageSquare size={18} />
                    All
                  </span>
                  <span>{filteredChats.length}</span>
                </button>
                <button
                  type="button"
                  className={`chats-rail-nav-item ${inboxView === 'unread' ? 'active' : ''}`}
                  onClick={() => setInboxView('unread')}
                >
                  <span className="chats-rail-nav-main">
                    <Clock3 size={18} />
                    Unread
                  </span>
                  <span>{totalUnread}</span>
                </button>
                <button
                  type="button"
                  className={`chats-rail-nav-item ${inboxView === 'direct' ? 'active' : ''}`}
                  onClick={() => setInboxView('direct')}
                >
                  <span className="chats-rail-nav-main">
                    <Phone size={18} />
                    Direct
                  </span>
                  <span>{directChats}</span>
                </button>
                <button
                  type="button"
                  className={`chats-rail-nav-item ${inboxView === 'groups' ? 'active' : ''}`}
                  onClick={() => setInboxView('groups')}
                >
                  <span className="chats-rail-nav-main">
                    <Users size={18} />
                    Groups
                  </span>
                  <span>{groupChats}</span>
                </button>
              </div>
            </div>

            <div className="chats-rail-group chats-rail-group--summary">
              <div className="chats-rail-label">Workspace health</div>
              <div className="chats-rail-stats">
                <div className="chats-rail-stat">
                  <span>WhatsApp</span>
                  <strong>{isSessionReady ? 'Online' : 'Reconnecting'}</strong>
                </div>
                <div className="chats-rail-stat">
                  <span>Unread</span>
                  <strong>{totalUnread}</strong>
                </div>
                <div className="chats-rail-stat">
                  <span>Mix</span>
                  <strong>
                    {directChats}/{groupChats}
                  </strong>
                </div>
              </div>
            </div>
          </aside>

          <section className="chats-inbox">
            <div className="chats-inbox-header">
              <div>
                <div className="chats-inbox-title">{inboxTitle}</div>
                <div className="chats-inbox-subtitle">{inboxSubtitle}</div>
              </div>
              <button type="button" className="chats-inbox-channel">
                All channels
                <ChevronDown size={16} />
              </button>
            </div>

            <div className="chats-inbox-toolbar">
              <div className="chat-search-input">
                <Search size={18} />
                <input
                  type="text"
                  placeholder={t('chats.searchPlaceholder')}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
              </div>
              <button
                type="button"
                className={`chats-toolbar-chip ${inboxView === 'all' ? 'active' : ''}`}
                onClick={() => setInboxView('all')}
              >
                Open
              </button>
              <button
                type="button"
                className="chats-toolbar-chip"
                onClick={() => setSortMode(current => (current === 'recent' ? 'oldest' : 'recent'))}
              >
                <ArrowUpDown size={15} />
                {sortMode === 'recent' ? 'Recent first' : 'Started first'}
              </button>
              <button type="button" className="chats-toolbar-icon" aria-label="Filters">
                <Funnel size={16} />
              </button>
            </div>

            <div className="chats-list">
              {loadingChats ? (
                <div className="chats-list-loading">
                  <Loader2 className="animate-spin" size={24} />
                  <span>{t('chats.loadingChats')}</span>
                </div>
              ) : filteredChats.length === 0 ? (
                <div className="chats-list-empty">
                  <MessageSquare size={40} className="placeholder-icon" />
                  <span>{t('chats.empty')}</span>
                </div>
              ) : (
                filteredChats.map(chat => {
                  const isActive = activeChat?.id === chat.id;
                  return (
                    <div
                      key={chat.id}
                      className={`chat-item-card ${isActive ? 'active' : ''}`}
                      onClick={() => setActiveChat(chat)}
                    >
                      <div className="chat-avatar">{chat.isGroup ? <Users size={20} /> : <User size={20} />}</div>

                      <div className="chat-item-info">
                        <div className="chat-item-top">
                          <span className="chat-item-name" title={getChatDisplayName(chat)}>
                            {getChatDisplayName(chat)}
                          </span>
                          {chat.timestamp && <span className="chat-item-time">{formatChatTime(chat.timestamp)}</span>}
                        </div>
                        <div className="chat-item-bottom">
                          <span className="chat-item-snippet" title={formatLastMessageSnippet(chat)}>
                            {formatLastMessageSnippet(chat) || (
                              <span className="no-message">{t('chats.noMessageYet')}</span>
                            )}
                          </span>
                          <div className="chat-item-badges">
                            <span className={`chat-type-badge ${chat.isGroup ? 'group' : 'direct'}`}>
                              {chat.isGroup ? 'Group' : 'Direct'}
                            </span>
                            {chat.unreadCount > 0 && <span className="chat-unread-badge">{chat.unreadCount}</span>}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          <main className="chats-room">
            {activeChat ? (
              <div className="room-container">
                <header className="room-header">
                  <div className="room-header-main">
                    <div className="room-avatar">{activeChat.isGroup ? <Users size={20} /> : <User size={20} />}</div>
                    <div className="room-contact-info">
                      <h3>{getChatDisplayName(activeChat)}</h3>
                      {activeChat.phone ? (
                        <span>{activeChat.phone}</span>
                      ) : activeChat.name?.trim() &&
                        !activeChat.name.includes('@') &&
                        !activeChat.id.endsWith('@lid') ? (
                        <span>{getChatNumber(activeChat.id)}</span>
                      ) : null}
                      <div className="room-contact-meta">
                        <span>{activeChat.isGroup ? 'Shared workspace' : '1:1 conversation'}</span>
                        <span>{activeChatMessageCount} messages loaded</span>
                        <span>{historySource === 'live' ? 'WhatsApp history' : 'Stored history only'}</span>
                        <span>{activeChatUnread} unread</span>
                      </div>
                    </div>
                  </div>
                  <div className="room-header-actions">
                    <div className="room-header-pill">
                      <Wifi size={14} />
                      {isSessionReady ? 'Connected' : 'Waiting for WhatsApp'}
                    </div>
                    <div className="room-header-pill subtle">{activeChat.isGroup ? 'Group' : 'Direct'}</div>
                  </div>
                </header>

                <div className="room-messages" ref={roomMessagesRef}>
                  {loadingMessages ? (
                    <div className="messages-loading">
                      <Loader2 className="animate-spin" size={32} />
                      <span>{t('chats.loadingMessages')}</span>
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="messages-empty">
                      <MessageSquare size={32} />
                      <span>{t('chats.noMessagesInChat')}</span>
                    </div>
                  ) : (
                    <>
                      <div className="chat-history-controls">
                        {canLoadOlder && (
                          <button
                            type="button"
                            className="load-older-messages"
                            onClick={handleLoadOlderMessages}
                            disabled={loadingOlderMessages}
                          >
                            {loadingOlderMessages ? (
                              <Loader2 className="animate-spin" size={14} />
                            ) : (
                              <RefreshCw size={14} />
                            )}
                            {loadingOlderMessages ? 'Loading older messages...' : 'Load older messages'}
                          </button>
                        )}
                        {loadingMedia && (
                          <span className="media-loading-status">
                            <Loader2 className="animate-spin" size={13} />
                            Loading media
                          </span>
                        )}
                      </div>
                      {messages.map((msg, messageIndex) => {
                        const isMe = msg.direction === 'outgoing';
                        const currentTimestamp = messageTimestamp(msg);
                        const formattedTime = formatTime(currentTimestamp);
                        const previousMessage = messageIndex > 0 ? messages[messageIndex - 1] : null;
                        const showDateSeparator =
                          !previousMessage ||
                          new Date(messageTimestamp(previousMessage) * 1000).toDateString() !==
                            new Date(currentTimestamp * 1000).toDateString();

                        const isMediaMessage = msg.type !== 'text';
                        const mediaInfo = msg.metadata?.media;

                        const renderMedia = () => {
                          if (msg.type === 'revoked') return null;

                          if (msg.type === 'location' && msg.metadata?.location) {
                            const location = msg.metadata.location;
                            const mapUrl =
                              location.url ||
                              `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`;
                            return (
                              <a className="chat-location-media" href={mapUrl} target="_blank" rel="noreferrer">
                                <MapPin size={20} />
                                <span>
                                  <strong>{location.description || 'Shared location'}</strong>
                                  <small>{location.address || `${location.latitude}, ${location.longitude}`}</small>
                                </span>
                              </a>
                            );
                          }

                          const attachmentTypes: MessageType[] = [
                            'image',
                            'sticker',
                            'video',
                            'audio',
                            'voice',
                            'document',
                          ];
                          if (!attachmentTypes.includes(msg.type)) return null;

                          const mediaSrc = getMediaSrc(mediaInfo);
                          if (!mediaInfo || !mediaSrc) {
                            const mediaIcon =
                              msg.type === 'image' || msg.type === 'sticker' ? (
                                <ImageIcon size={18} />
                              ) : msg.type === 'video' ? (
                                <Video size={18} />
                              ) : msg.type === 'audio' || msg.type === 'voice' ? (
                                <Mic size={18} />
                              ) : (
                                <FileText size={18} />
                              );
                            return (
                              <div className="message-media-unavailable">
                                {mediaIcon}
                                <span>{loadingMedia ? 'Loading media...' : 'Media unavailable'}</span>
                              </div>
                            );
                          }

                          switch (msg.type) {
                            case 'image':
                            case 'sticker':
                              return (
                                <div className="message-media-image">
                                  <a href={mediaSrc} target="_blank" rel="noreferrer">
                                    <img
                                      src={mediaSrc}
                                      alt={mediaInfo.filename || 'WhatsApp image'}
                                      className={`chat-image-media ${msg.type === 'sticker' ? 'sticker' : ''}`}
                                      loading="lazy"
                                    />
                                  </a>
                                </div>
                              );
                            case 'video':
                              return (
                                <div className="message-media-video">
                                  <video src={mediaSrc} controls preload="metadata" className="chat-video-media" />
                                </div>
                              );
                            case 'audio':
                            case 'voice':
                              return (
                                <div className="message-media-audio">
                                  <audio src={mediaSrc} controls preload="metadata" className="chat-audio-media" />
                                </div>
                              );
                            case 'document':
                              return (
                                <div className="message-media-document">
                                  <a
                                    href={mediaSrc}
                                    download={mediaInfo.filename || 'document'}
                                    className="chat-document-media"
                                  >
                                    <FileText size={18} />
                                    <span>{mediaInfo.filename || t('chats.downloadDocument')}</span>
                                    <Download size={15} />
                                  </a>
                                </div>
                              );
                            default:
                              return null;
                          }
                        };

                        const reactions = msg.metadata?.reactions || {};
                        const hasReactions = Object.keys(reactions).length > 0;
                        const isRevoked = msg.type === 'revoked';

                        return (
                          <Fragment key={messageIdentity(msg)}>
                            {showDateSeparator && (
                              <div className="message-date-separator">
                                <span>{formatMessageDate(currentTimestamp)}</span>
                              </div>
                            )}
                            <div className={`message-bubble-wrapper ${isMe ? 'outgoing' : 'incoming'}`}>
                              <div className="message-bubble-container">
                                <div
                                  className={`message-bubble ${isMe ? 'outgoing' : 'incoming'} ${msg.status} ${
                                    isMediaMessage ? 'media-type' : ''
                                  } ${isRevoked ? 'revoked-type' : ''}`}
                                >
                                  {/* Quoted message display */}
                                  {msg.metadata?.quotedMessage && (
                                    <div className="message-quote-box">
                                      <div className="quote-body">{msg.metadata.quotedMessage.body}</div>
                                    </div>
                                  )}

                                  {renderMedia()}

                                  {isRevoked ? (
                                    <div className="message-text">{t('chats.messageDeleted')}</div>
                                  ) : (
                                    msg.body &&
                                    (!mediaInfo || msg.body !== mediaInfo.filename) && (
                                      <div className="message-text">{msg.body}</div>
                                    )
                                  )}

                                  <div className="message-meta">
                                    <span className="message-time">{formattedTime}</span>
                                    {isMe && (
                                      <span className={`message-status-icon ${msg.status}`}>
                                        {msg.status === 'pending' && '🕒'}
                                        {msg.status === 'sent' && '✓'}
                                        {msg.status === 'delivered' && '✓✓'}
                                        {msg.status === 'read' && '✓✓'}
                                        {msg.status === 'failed' && '⚠️'}
                                      </span>
                                    )}
                                  </div>

                                  {/* Reactions display */}
                                  {hasReactions && (
                                    <div className="message-reactions-badge">
                                      {Object.values(reactions)
                                        .slice(0, 3)
                                        .map((emoji, idx) => (
                                          <span key={idx} className="reaction-emoji-span">
                                            {emoji}
                                          </span>
                                        ))}
                                      {Object.keys(reactions).length > 1 && (
                                        <span className="reactions-count-span">{Object.keys(reactions).length}</span>
                                      )}
                                    </div>
                                  )}
                                </div>

                                {/* Message actions menu (hover) */}
                                {!isRevoked && (
                                  <div className="message-actions-menu">
                                    <button
                                      type="button"
                                      className="action-btn"
                                      onClick={() => setReplyingTo(msg)}
                                      title={t('chats.actions.reply')}
                                    >
                                      <CornerUpLeft size={14} />
                                    </button>

                                    <div className="reaction-trigger-wrapper">
                                      <button
                                        type="button"
                                        className="action-btn reaction-btn"
                                        title={t('chats.actions.react')}
                                      >
                                        <Smile size={14} />
                                      </button>
                                      <div className="reaction-quick-popover">
                                        {['👍', '❤️', '😂', '😮', '😢', '🙏'].map(emoji => (
                                          <button
                                            key={emoji}
                                            type="button"
                                            onClick={() => handleReactMessage(msg, emoji)}
                                          >
                                            {emoji}
                                          </button>
                                        ))}
                                      </div>
                                    </div>

                                    {isMe && msg.status !== 'pending' && (
                                      <button
                                        type="button"
                                        className="action-btn delete-btn"
                                        onClick={() => handleDeleteMessage(msg)}
                                        title={t('chats.actions.delete')}
                                      >
                                        <Trash2 size={14} />
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          </Fragment>
                        );
                      })}
                    </>
                  )}
                  <div ref={chatBottomRef} />
                </div>

                {/* Attachment preview banner */}
                {attachment && (
                  <div className="attachment-preview-banner">
                    {previewUrl ? (
                      <img src={previewUrl} alt={attachment.filename} className="preview-thumbnail" />
                    ) : (
                      <div className="preview-file-icon">📎</div>
                    )}
                    <div className="preview-file-info">
                      <span className="preview-filename">{attachment.filename}</span>
                      <span className="preview-filesize">({(attachment.file.size / 1024).toFixed(1)} KB)</span>
                    </div>
                    <button className="btn-remove-attachment" onClick={handleRemoveAttachment}>
                      <X size={18} />
                    </button>
                  </div>
                )}

                {/* Popular emojis panel */}
                {showEmojiPicker && (
                  <div className="chats-emoji-picker">
                    <div className="emoji-grid">
                      {popularEmojis.map(emoji => (
                        <button key={emoji} type="button" className="emoji-btn" onClick={() => handleEmojiClick(emoji)}>
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Replying preview banner */}
                {replyingTo && (
                  <div className="replying-preview-banner">
                    <div className="replying-preview-content">
                      <div className="replying-to-title">
                        {t('chats.replyingTo', {
                          name: replyingTo.direction === 'outgoing' ? t('chats.you') : getChatDisplayName(activeChat),
                        })}
                      </div>
                      <div className="replying-to-body">
                        {replyingTo.type !== 'text' ? `[${replyingTo.type}]` : replyingTo.body}
                      </div>
                    </div>
                    <button className="btn-close-reply" onClick={() => setReplyingTo(null)}>
                      <X size={18} />
                    </button>
                  </div>
                )}

                {/* Message input bar */}
                <footer className="room-input-footer">
                  <form onSubmit={handleSend} className="input-form">
                    <input type="file" ref={fileInputRef} onChange={handleFileChange} style={{ display: 'none' }} />

                    <button
                      type="button"
                      onClick={triggerFileSelect}
                      disabled={!canWrite || !isSessionReady || sending}
                      className="btn-input-accessory"
                      title={t('chats.attachTitle')}
                    >
                      <Paperclip size={20} />
                    </button>

                    <button
                      type="button"
                      onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                      disabled={!canWrite || !isSessionReady || sending}
                      className={`btn-input-accessory ${showEmojiPicker ? 'active' : ''}`}
                      title={t('chats.emojiTitle')}
                    >
                      <Smile size={20} />
                    </button>

                    <input
                      type="text"
                      placeholder={
                        canWrite
                          ? !isSessionReady
                            ? 'Waiting for WhatsApp to reconnect...'
                            : attachment
                              ? t('chats.captionPlaceholder')
                              : t('chats.messagePlaceholder')
                          : t('chats.noPermission')
                      }
                      value={messageInput}
                      onChange={e => setMessageInput(e.target.value)}
                      disabled={!canWrite || !isSessionReady || sending}
                      className="message-text-input"
                    />
                    <button
                      type="submit"
                      disabled={!canWrite || !isSessionReady || (!messageInput.trim() && !attachment) || sending}
                      className="btn-send-message"
                      aria-label={t('chats.send')}
                    >
                      {sending ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
                    </button>
                  </form>
                </footer>
              </div>
            ) : (
              <div className="chats-room-placeholder">
                <div className="chats-room-placeholder-orb">
                  <MessageSquare size={80} className="placeholder-icon" />
                </div>
                <h2>Select a conversation</h2>
                <p>
                  Pick a thread from the inbox to start replying, reviewing context, and handling WhatsApp chats faster.
                </p>
                <div className="chats-placeholder-grid">
                  <div className="chats-placeholder-card">
                    <strong>Pick a conversation</strong>
                    <span>Use the center column to scan unread threads, recent activity, and group chats.</span>
                  </div>
                  <div className="chats-placeholder-card">
                    <strong>Reply with context</strong>
                    <span>Keep replies, reactions, attachments, and customer history in one focused pane.</span>
                  </div>
                </div>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
