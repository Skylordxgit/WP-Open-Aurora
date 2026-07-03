import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  Search,
  Loader2,
  Users,
  AlertCircle,
  MessageSquare,
  ChevronDown,
  Funnel,
  ArrowUpDown,
  Phone,
  Clock3,
  Settings,
} from 'lucide-react';
import {
  sessionApi,
  messageApi,
  asMessageType,
  type Session,
  type MessageType,
} from '../services/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../components/Toast';
import {
  ChatRow,
  MessageBubble,
  DateSeparator,
  ConversationHeader,
  Composer,
  InfoPanel,
  formatTime,
  formatChatTime,
  formatDateSeparator,
  formatContactDisplay,
  stripJidSuffix,
  messageTypeFromMime,
  type ChatWithSession,
  type ChatMessageView,
  type MediaDownloadStatus,
} from '../components/chats';
import { useAllChatLabelsQuery, useLabelsQuery } from '../hooks/queries';
import './Chats.css';

interface IncomingWsMessage {
  id: string;
  chatId: string;
  from: string;
  to: string;
  body: string;
  type: string;
  timestamp: number;
  fromMe?: boolean;
  media?: { mimetype: string; filename?: string; data?: string; size?: number; duration?: number };
  quotedMessage?: { id: string; body: string };
  metadata?: ChatMessageView['metadata'];
}

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

// Popular emojis
const POPULAR_EMOJIS = ['😀', '😂', '👍', '❤️', '🔥', '👏', '🙏', '🎉', '💡', '🤔', '😅', '😍', '😊', '😭', '😎', '😜', '🚀', '✨'];

export function Chats() {
  const { t } = useTranslation();
  useDocumentTitle(t('nav.chats'));
  const { canWrite } = useRole();
  const { error: showErrorToast, warning: showWarningToast } = useToast();

  // Sessions list & active session
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [loadingSessions, setLoadingSessions] = useState<boolean>(true);

  // Chats list — merged from every selected channel
  const [chats, setChats] = useState<ChatWithSession[]>([]);
  const [loadingChats, setLoadingChats] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [inboxView, setInboxView] = useState<'all' | 'unread' | 'direct' | 'groups'>('all');
  const [sortMode, setSortMode] = useState<'recent' | 'oldest'>('recent');

  // Channels included in the inbox: one selected shows that account's chats only, several
  // selected merge their chats together.
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([]);
  const [showChannelMenu, setShowChannelMenu] = useState<boolean>(false);
  const channelMenuRef = useRef<HTMLDivElement | null>(null);
  const inboxSearchRef = useRef<HTMLInputElement | null>(null);

  // Selected chat & message history
  const [activeChat, setActiveChat] = useState<ChatWithSession | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [loadingMessages, setLoadingMessages] = useState<boolean>(false);
  const [messagesTotal, setMessagesTotal] = useState<number>(0); // real DB count for this chat
  const [loadingOlder, setLoadingOlder] = useState<boolean>(false); // "load older" in flight
  // Whether the oldest stored message has been loaded. Gates the "Load older" control independently
  // of message counts, so live/sent appends can't make the control disappear while older history
  // remains unloaded.
  const [reachedOldest, setReachedOldest] = useState<boolean>(false);
  const [messageInput, setMessageInput] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);
  // Per-message media download status (on-demand "Load media"). Keyed by message id; an absent
  // entry means idle. History media is never auto-downloaded — only fetched on user click.
  const [mediaDownloads, setMediaDownloads] = useState<Record<string, MediaDownloadStatus>>({});
  // Briefly highlighted message id (jump-to-quoted-message flash).
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  // Channels whose chat fetch failed on the last load — surfaced non-blockingly in the inbox.
  const [failedChannelIds, setFailedChannelIds] = useState<string[]>([]);

  // Request-generation guards: only the newest load is allowed to commit state, so a slow/older
  // response from a previous channel/chat selection can never overwrite a newer one.
  const loadChatsReqRef = useRef(0);
  const loadMessagesReqRef = useRef(0);
  // Set before prepending older history so the bottom-auto-scroll effect skips that one update.
  const skipNextAutoScrollRef = useRef(false);
  // Auto-scroll control: only jump to bottom on chat-open / send, or when the user is already there.
  const isNearBottomRef = useRef(true);
  const forceScrollRef = useRef(false);
  // Mirror of `chats` + a debounce timer so an unknown-chat refresh can be triggered WITHOUT calling
  // setState inside a state updater (keeps the reducer pure).
  const chatsRef = useRef<ChatWithSession[]>([]);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // File attachments
  const [attachment, setAttachment] = useState<{
    file: File;
    base64: string;
    mimetype: string;
    filename: string;
  } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState<boolean>(false);
  const [showInfo, setShowInfo] = useState<boolean>(false); // Chat Info drawer (presentational toggle)
  const [labelFilterId, setLabelFilterId] = useState<string>(''); // '' = no label filter

  // Persistent chat labels (DB-backed). Map keyed `${sessionId}::${chatId}`.
  const { data: allLabels = [] } = useLabelsQuery();
  const { data: chatLabelMap = {} } = useAllChatLabelsQuery();

  // References
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);

  // 1. Fetch available connected sessions on mount
  useEffect(() => {
    const loadSessions = async () => {
      try {
        setLoadingSessions(true);
        const list = await sessionApi.list();
        // Include ALL sessions, not just connected ones: the backend serves stored
        // chat history for offline sessions, so hiding them made every chat vanish
        // after a backend restart. Connected sessions sort first.
        const ordered = [...list].sort((a, b) => Number(b.status === 'ready') - Number(a.status === 'ready'));
        setSessions(ordered);
        if (ordered.length > 0) {
          const preferred = ordered.find(s => s.status === 'ready') ?? ordered[0];
          setSelectedSessionId(preferred.id);
          setSelectedChannelIds(ordered.map(s => s.id));
        }
      } catch (err) {
        showErrorToast(t('chats.errors.loadSessions'), err instanceof Error ? err.message : undefined);
      } finally {
        setLoadingSessions(false);
      }
    };
    void loadSessions();
  }, [t, showErrorToast]);

  // 2. Fetch chats for every selected channel and merge them into one inbox
  const loadChats = useCallback(
    async (sessionIds: string[]) => {
      const reqId = ++loadChatsReqRef.current;
      if (sessionIds.length === 0) {
        setChats([]);
        setFailedChannelIds([]);
        return;
      }
      setLoadingChats(true);
      const failed: string[] = [];
      const perChannel = await Promise.all(
        sessionIds.map(async sessionId => {
          try {
            const data = await sessionApi.getChats(sessionId);
            return data.map(chat => ({ ...chat, sessionId }));
          } catch (err) {
            failed.push(sessionId);
            showErrorToast(t('chats.errors.loadChats'), err instanceof Error ? err.message : undefined);
            return [];
          }
        }),
      );
      // A newer load started while this one was in flight — discard this (stale) result entirely.
      if (reqId !== loadChatsReqRef.current) return;
      const merged = perChannel.flat().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      // Debug: chat-flow counts (API -> render). Per-channel counts + failures.
      console.debug(
        `[chats] loaded ${merged.length} chats from ${sessionIds.length} channel(s)`,
        perChannel.map((c, i) => `${sessionIds[i]}: ${c.length}`),
        failed.length ? `failed: ${failed.join(', ')}` : '',
      );
      setChats(merged);
      setFailedChannelIds(failed);
      setLoadingChats(false);
    },
    [t, showErrorToast],
  );

  useEffect(() => {
    void loadChats(selectedChannelIds);
    setActiveChat(null);
    setMessages([]);
    setAttachment(null);
    setPreviewUrl(null);
  }, [selectedChannelIds, loadChats]);

  // Keep a non-reactive mirror of the chat list so realtime handlers can detect an unknown chat
  // without depending on `chats` (and without reading state inside a reducer).
  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

  // Debounced refresh used when a message arrives for a chat not yet in the list. Coalesces bursts
  // into a single reload instead of fetching per message, and never runs inside a state updater.
  const scheduleChatsRefresh = useCallback(
    (sessionIds: string[]) => {
      if (refreshTimerRef.current != null) return;
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        void loadChats(sessionIds);
      }, 1200);
    },
    [loadChats],
  );

  // Clear any pending refresh timer on unmount.
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current != null) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  const markChatRead = useCallback(
    (sessionId: string, chatId: string) => {
      void sessionApi.markChatRead(sessionId, chatId).catch(err => {
        showWarningToast(t('chats.errors.markRead'), err instanceof Error ? err.message : undefined);
      });
    },
    [t, showWarningToast],
  );

  // 3. WebSocket integration for real-time messages
  const handleIncomingMessage = useCallback(
    (event: { sessionId: string; message: Record<string, unknown> }) => {
      if (!selectedChannelIds.includes(event.sessionId)) return;

      const newMsg = event.message as unknown as IncomingWsMessage;

      // Update message list if the message belongs to the currently active chat
      if (activeChat && newMsg.chatId === activeChat.id && event.sessionId === activeChat.sessionId) {
        markChatRead(activeChat.sessionId, activeChat.id);

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

      // An unknown chat (not yet in the list) is refreshed via a debounced reload — decided here,
      // OUTSIDE the setChats updater, so the reducer stays pure.
      const isKnownChat =
        chatsRef.current.findIndex(c => c.id === newMsg.chatId && c.sessionId === event.sessionId) !== -1;
      if (!isKnownChat) {
        scheduleChatsRefresh(selectedChannelIds);
      }

      // Update sidebar chat list (pure updater).
      setChats(prevChats => {
        const chatIndex = prevChats.findIndex(
          c => c.id === newMsg.chatId && c.sessionId === event.sessionId,
        );
        if (chatIndex === -1) {
          return prevChats; // not loaded yet — the scheduled refresh above will bring it in
        }

        const updatedChats = [...prevChats];
        const targetChat = { ...updatedChats[chatIndex] };
        targetChat.lastMessage = newMsg.body;
        targetChat.timestamp = newMsg.timestamp;

        if (!newMsg.fromMe && (!activeChat || activeChat.id !== targetChat.id || activeChat.sessionId !== event.sessionId)) {
          targetChat.unreadCount = (targetChat.unreadCount || 0) + 1;
        }

        updatedChats.splice(chatIndex, 1);
        updatedChats.unshift(targetChat);
        return updatedChats;
      });
    },
    [selectedChannelIds, activeChat, scheduleChatsRefresh, markChatRead],
  );

  const handleIncomingMessageAck = useCallback(
    (event: { sessionId: string; messageId: string; status: ChatMessageView['status'] }) => {
      if (!activeChat || event.sessionId !== activeChat.sessionId) return;

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
    [activeChat],
  );

  const handleIncomingMessageReaction = useCallback(
    (event: { sessionId: string; messageId: string; reactions: Record<string, string> }) => {
      if (!activeChat || event.sessionId !== activeChat.sessionId) return;

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
    [activeChat],
  );

  const handleIncomingMessageRevoked = useCallback(
    (event: { sessionId: string; id: string; type: string }) => {
      if (!activeChat || event.sessionId !== activeChat.sessionId) return;

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
    [activeChat],
  );

  const { isConnected, connectionFailed, reconnect, subscribe, unsubscribe } = useWebSocket({
    onMessage: handleIncomingMessage,
    onMessageAck: handleIncomingMessageAck,
    onMessageReaction: handleIncomingMessageReaction,
    onMessageRevoked: handleIncomingMessageRevoked,
  });

  useEffect(() => {
    if (selectedChannelIds.length > 0 && isConnected) {
      selectedChannelIds.forEach(sessionId => {
        subscribe(sessionId, [
          'message.received',
          'message.sent',
          'message.ack',
          'message.reaction',
          'message.revoked',
        ]);
      });
      return () => {
        selectedChannelIds.forEach(sessionId => unsubscribe(sessionId));
      };
    }
  }, [selectedChannelIds, isConnected, subscribe, unsubscribe]);

  // Count of DB-backed messages currently shown (optimistic temp rows are not yet persisted, so
  // they must not count toward the pagination offset).
  const loadedPersistedCount = messages.reduce(
    (n, m) => (String(m.id).startsWith('temp_') ? n : n + 1),
    0,
  );

  // 4. Fetch message history for the selected chat
  const loadMessages = useCallback(
    async (sessionId: string, chatId: string) => {
      if (!sessionId || !chatId) return;
      const reqId = ++loadMessagesReqRef.current;
      setLoadingMessages(true);
      markChatRead(sessionId, chatId);
      try {
        const data = await sessionApi.getChatMessages(sessionId, chatId, 100);
        if (reqId !== loadMessagesReqRef.current) return; // chat switched mid-flight — discard
        const total = typeof data.total === 'number' ? data.total : data.messages.length;
        forceScrollRef.current = true; // opening a chat always lands at the latest message
        setMessages([...data.messages].reverse());
        setMessagesTotal(total);
        // We've loaded the newest page; older history remains only if the DB holds more than we got.
        setReachedOldest(data.messages.length >= total);
      } catch (err) {
        if (reqId !== loadMessagesReqRef.current) return;
        showErrorToast(t('chats.errors.loadMessages'), err instanceof Error ? err.message : undefined);
        setMessages([]);
        setMessagesTotal(0);
        setReachedOldest(true);
      } finally {
        if (reqId === loadMessagesReqRef.current) setLoadingMessages(false);
      }
    },
    [markChatRead, t, showErrorToast],
  );

  // Append the next older page of history (uses the backend's existing offset paging). The offset is
  // the count of PERSISTED messages loaded (excludes optimistic temp rows), so live/sent appends
  // don't skew it. Older messages are prepended and de-duplicated, preserving chronological order.
  const loadOlderMessages = useCallback(async () => {
    if (!activeChat || loadingOlder || loadingMessages || reachedOldest) return;
    const reqId = loadMessagesReqRef.current; // tie this page to the current chat's load generation
    const { sessionId, id: chatId } = activeChat;
    const offset = loadedPersistedCount; // count of non-temp (DB-backed) messages currently shown
    setLoadingOlder(true);
    try {
      const data = await sessionApi.getChatMessages(sessionId, chatId, 100, offset);
      if (reqId !== loadMessagesReqRef.current) return; // chat switched — discard
      if (data.messages.length === 0) {
        setReachedOldest(true); // no more stored history
        return;
      }
      const older = [...data.messages].reverse(); // oldest-first
      skipNextAutoScrollRef.current = true; // don't yank the view to the bottom when prepending
      setMessages(prev => {
        const seen = new Set(prev.map(m => m.waMessageId || m.id));
        const deduped = older.filter(m => !seen.has(m.waMessageId || m.id));
        if (deduped.length === 0) {
          skipNextAutoScrollRef.current = false; // nothing prepended — don't swallow a later scroll
          return prev;
        }
        return [...deduped, ...prev];
      });
      if (typeof data.total === 'number') setMessagesTotal(prev => Math.max(prev, data.total));
      // A short page means we've reached the start of stored history.
      if (data.messages.length < 100) setReachedOldest(true);
    } catch (err) {
      showErrorToast(t('chats.errors.loadMessages'), err instanceof Error ? err.message : undefined);
    } finally {
      setLoadingOlder(false);
    }
  }, [activeChat, loadedPersistedCount, loadingOlder, loadingMessages, reachedOldest, t, showErrorToast]);

  // Download the media for a single message on demand and merge it into ONLY that message's state.
  // Never touches other rows, and suppresses the next auto-scroll so loading media doesn't yank the
  // view — keeping the scroll position stable while the user browses history.
  const handleDownloadMedia = useCallback(
    async (msg: ChatMessageView) => {
      if (!activeChat) return;
      const key = msg.id;
      const remoteId = msg.waMessageId || msg.id;
      setMediaDownloads(prev => ({ ...prev, [key]: 'loading' }));
      try {
        const media = await sessionApi.downloadMessageMedia(activeChat.sessionId, activeChat.id, remoteId);
        skipNextAutoScrollRef.current = true; // inserting media must not scroll the reader away
        setMessages(prev =>
          prev.map(m => {
            if (m.id !== msg.id) return m;
            const metadata = m.metadata || {};
            return {
              ...m,
              metadata: {
                ...metadata,
                media: { mimetype: media.mimetype, filename: media.filename, data: media.data },
              },
            };
          }),
        );
        setMediaDownloads(prev => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      } catch (err) {
        setMediaDownloads(prev => ({ ...prev, [key]: 'error' }));
        showErrorToast(
          t('chats.errors.loadMedia', { defaultValue: 'Failed to load media' }),
          err instanceof Error ? err.message : undefined,
        );
      }
    },
    [activeChat, showErrorToast, t],
  );

  const handleReactMessage = useCallback(
    async (msg: ChatMessageView, emoji: string) => {
      if (!activeChat) return;

      const msgId = msg.waMessageId || msg.id;
      const currentReactions = msg.metadata?.reactions || {};
      const sessionPhone = sessions.find(s => s.id === activeChat.sessionId)?.phone || 'me';

      let alreadyReacted = false;
      for (const [sender, emo] of Object.entries(currentReactions)) {
        if ((sender === 'me' || sender.includes(sessionPhone)) && emo === emoji) {
          alreadyReacted = true;
          break;
        }
      }

      const emojiToSend = alreadyReacted ? '' : emoji;

      try {
        await messageApi.react(activeChat.sessionId, {
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
    },
    [activeChat, sessions, t, showErrorToast],
  );

  const handleDeleteMessage = useCallback(
    async (msg: ChatMessageView) => {
      if (!activeChat) return;
      const msgId = msg.waMessageId || msg.id;

      if (!window.confirm(t('chats.deleteConfirm'))) return;

      try {
        await messageApi.delete(activeChat.sessionId, {
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
    },
    [activeChat, t, showErrorToast],
  );

  useEffect(() => {
    if (activeChat) {
      void loadMessages(activeChat.sessionId, activeChat.id);
      setChats(prev =>
        prev.map(c =>
          c.id === activeChat.id && c.sessionId === activeChat.sessionId ? { ...c, unreadCount: 0 } : c,
        ),
      );
    } else {
      setMessages([]);
      setMessagesTotal(0);
    }
  }, [activeChat, loadMessages]);

  // Esc closes the Chat Info drawer (or any other open overlay/menu).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showInfo) setShowInfo(false);
      else if (showChannelMenu) setShowChannelMenu(false);
      else if (showEmojiPicker) setShowEmojiPicker(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showInfo, showChannelMenu, showEmojiPicker]);

  // Drop the drawer if the conversation is cleared (e.g. channel switch).
  useEffect(() => {
    if (!activeChat) setShowInfo(false);
  }, [activeChat]);

  // Close the channel filter dropdown when clicking outside of it
  useEffect(() => {
    if (!showChannelMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (channelMenuRef.current && !channelMenuRef.current.contains(e.target as Node)) {
        setShowChannelMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showChannelMenu]);

  const toggleChannelSelection = (sessionId: string) => {
    setSelectedChannelIds(prev => {
      if (prev.includes(sessionId)) {
        if (prev.length === 1) return prev; // always keep at least one channel selected
        return prev.filter(id => id !== sessionId);
      }
      return [...prev, sessionId];
    });
  };

  // 5. Auto-scroll to bottom only when appropriate: on chat-open / send (forceScrollRef), or when
  // the user is already near the bottom. If they've scrolled up to read history, don't yank them
  // down on acks/reactions/incoming. Prepending older history is skipped entirely.
  useEffect(() => {
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false;
      return;
    }
    if (forceScrollRef.current || isNearBottomRef.current) {
      forceScrollRef.current = false;
      chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Track whether the message view is scrolled near the bottom (drives the auto-scroll decision).
  const handleMessagesScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // Jump to (and briefly highlight) the original message referenced by a reply card. Scrolling
  // and the flash are purely presentational — they never trigger a refetch.
  const handleJumpToQuoted = useCallback((quotedId: string) => {
    const target = messages.find(m => m.id === quotedId || m.waMessageId === quotedId);
    if (!target) return;
    const el = document.getElementById(`msg-${target.id}`);
    if (!el) return;
    skipNextAutoScrollRef.current = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedMessageId(target.id);
    setTimeout(() => setHighlightedMessageId(curr => (curr === target.id ? null : curr)), 1600);
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
    if (!activeChat || sending) return;

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
      type: attachment ? (messageTypeFromMime(attachment.mimetype) as MessageType) : 'text',
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

    forceScrollRef.current = true; // sending always scrolls the composer's message into view
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

        result = await messageApi.sendMedia(activeChat.sessionId, activeChat.id, mediaType, {
          base64: currentAttachment.base64,
          mimetype: currentAttachment.mimetype,
          filename: currentAttachment.filename,
          caption: mediaType !== 'audio' ? textToSend : undefined,
        });
      } else if (currentReplyingTo) {
        result = await messageApi.reply(activeChat.sessionId, {
          chatId: activeChat.id,
          quotedMessageId: currentReplyingTo.waMessageId || currentReplyingTo.id,
          text: textToSend,
        });
      } else {
        result = await messageApi.sendText(activeChat.sessionId, activeChat.id, textToSend);
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

      // Update sidebar chat list (move active chat to the top with the new snippet). Match on the
      // composite sessionId + chatId identity — the same contact can exist on multiple channels, so
      // a chatId-only match could move the wrong session's row to the top.
      setChats(prevChats => {
        const chatIndex = prevChats.findIndex(
          c => c.id === activeChat.id && c.sessionId === activeChat.sessionId,
        );
        if (chatIndex === -1) return prevChats;
        const updatedChats = [...prevChats];
        const target = { ...updatedChats[chatIndex] };
        target.lastMessage = currentAttachment
          ? `[${currentAttachment.mimetype.split('/')[0]}]`
          : textToSend;
        target.timestamp = Math.floor(Date.now() / 1000);
        updatedChats.splice(chatIndex, 1);
        updatedChats.unshift(target);
        return updatedChats;
      });
    } catch (err) {
      showErrorToast(t('chats.errors.send'), err instanceof Error ? err.message : undefined);
      setMessages(prev => prev.map(m => (m.id === tempId ? { ...m, status: 'failed' } : m)));
    } finally {
      setSending(false);
    }
  };

  const totalUnread = chats.reduce((sum, chat) => sum + (chat.unreadCount || 0), 0);
  const directChats = chats.filter(chat => !chat.isGroup).length;
  const groupChats = chats.filter(chat => chat.isGroup).length;
  const activeChatMessageCount = messages.length;
  const activeChatUnread = activeChat?.unreadCount || 0;

  // Stats computed from the loaded messages only (no fetch). Surfaced in the Chat Info panel.
  const messageStats = useMemo(
    () =>
      messages.reduce(
        (acc, m) => {
          if (m.direction === 'outgoing') acc.outgoing += 1;
          else acc.incoming += 1;
          if (m.type !== 'text' && m.type !== 'revoked') acc.media += 1;
          return acc;
        },
        { incoming: 0, outgoing: 0, media: 0 },
      ),
    [messages],
  );

  // Phone number for a 1:1 chat is encoded in the JID (e.g. 1234567890@c.us). Groups have no number.
  // Resolved phone digits for the active chat (backend-resolved, else the @c.us
  // local part). Never the raw LID — InfoPanel formats this and shows "Unknown".
  const activeChatPhone = activeChat
    ? activeChat.phone ||
      (!activeChat.isGroup && !activeChat.id.includes('@lid') ? stripJidSuffix(activeChat.id) : '')
    : '';

  // The channel the active chat actually belongs to (multi-channel safe — not the rail selector).
  const activeChatSession = activeChat ? sessions.find(s => s.id === activeChat.sessionId) || null : null;
  const selectedChannelName = activeChatSession?.name || 'Session';
  const activeChannelPhone = activeChatSession?.phone || '';

  const filteredChats = useMemo(
    () =>
      chats
        .filter(chat => {
          const query = searchQuery.toLowerCase();
          const matchesSearch =
            chat.name?.toLowerCase().includes(query) ||
            chat.id.toLowerCase().includes(query) ||
            stripJidSuffix(chat.id).includes(query);

          if (!matchesSearch) return false;
          if (labelFilterId) {
            const labels = chatLabelMap[`${chat.sessionId}::${chat.id}`] ?? [];
            if (!labels.some(l => l.id === labelFilterId)) return false;
          }
          if (inboxView === 'unread') return (chat.unreadCount || 0) > 0;
          if (inboxView === 'direct') return !chat.isGroup;
          if (inboxView === 'groups') return chat.isGroup;
          return true;
        })
        .sort((a, b) => {
          const aTime = a.timestamp || 0;
          const bTime = b.timestamp || 0;
          return sortMode === 'recent' ? bTime - aTime : aTime - bTime;
        }),
    [chats, searchQuery, inboxView, sortMode, labelFilterId, chatLabelMap],
  );

  // Pre-compute per-message grouping (consecutive same-sender runs) and date separators in a single
  // pass so the render below stays a flat, memoizable list without recomputing this per item.
  const renderItems = useMemo(() => {
    const items: Array<
      | { kind: 'separator'; key: string; label: string }
      | { kind: 'message'; key: string; msg: ChatMessageView; isGrouped: boolean; showSenderName: boolean }
    > = [];
    let lastDateLabel: string | null = null;
    let lastSenderKey: string | null = null;
    let lastTimestamp = 0;

    messages.forEach(msg => {
      const ts = msg.timestamp || Math.floor(new Date(msg.createdAt).getTime() / 1000);
      const dateLabel = formatDateSeparator(ts, t('chats.today', { defaultValue: 'Today' }), t('chats.yesterday'));
      if (dateLabel !== lastDateLabel) {
        items.push({ kind: 'separator', key: `sep-${dateLabel}-${msg.id}`, label: dateLabel });
        lastDateLabel = dateLabel;
        lastSenderKey = null; // a new day always starts a fresh group
      }
      const senderKey = msg.direction === 'outgoing' ? 'me' : msg.from;
      // Group consecutive messages from the same sender within a 5-minute window.
      const isGrouped = senderKey === lastSenderKey && ts - lastTimestamp < 300;
      items.push({
        kind: 'message',
        key: msg.id,
        msg,
        isGrouped,
        showSenderName: !isGrouped && !!activeChat?.isGroup && msg.direction === 'incoming',
      });
      lastSenderKey = senderKey;
      lastTimestamp = ts;
    });
    return items;
  }, [messages, activeChat, t]);

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
              Please connect a WhatsApp session from the <strong>Sessions</strong> menu first to use the chat
              feature.
            </Trans>
          </p>
        </div>
      ) : (
        <div className={`chats-layout ${showInfo && activeChat ? 'info-open' : ''}`}>
          <aside className="chats-iconbar">
            <div className="chats-iconbar-logo" title="Workspace">
              <MessageSquare size={20} />
            </div>
            <nav className="chats-iconbar-nav">
              <button
                type="button"
                className={`chats-iconbar-btn ${inboxView === 'all' ? 'active' : ''}`}
                onClick={() => setInboxView('all')}
                title="All conversations"
                aria-label="All conversations"
              >
                <MessageSquare size={20} />
                {filteredChats.length > 0 && (
                  <span className="chats-iconbar-count">{filteredChats.length}</span>
                )}
              </button>
              <button
                type="button"
                className={`chats-iconbar-btn ${inboxView === 'unread' ? 'active' : ''}`}
                onClick={() => setInboxView('unread')}
                title="Unread"
                aria-label="Unread"
              >
                <Clock3 size={20} />
                {totalUnread > 0 && <span className="chats-iconbar-count alert">{totalUnread}</span>}
              </button>
              <button
                type="button"
                className={`chats-iconbar-btn ${inboxView === 'direct' ? 'active' : ''}`}
                onClick={() => setInboxView('direct')}
                title="Direct"
                aria-label="Direct"
              >
                <Phone size={20} />
                {directChats > 0 && <span className="chats-iconbar-count">{directChats}</span>}
              </button>
              <button
                type="button"
                className={`chats-iconbar-btn ${inboxView === 'groups' ? 'active' : ''}`}
                onClick={() => setInboxView('groups')}
                title="Groups"
                aria-label="Groups"
              >
                <Users size={20} />
                {groupChats > 0 && <span className="chats-iconbar-count">{groupChats}</span>}
              </button>
            </nav>
            <div className="chats-iconbar-foot">
              <button type="button" className="chats-iconbar-btn" title="Settings" aria-label="Settings">
                <Settings size={18} />
              </button>
              <span
                className={`chats-iconbar-dot ${isConnected ? 'online' : 'syncing'}`}
                title={isConnected ? 'Connected' : 'Reconnecting'}
              />
            </div>
          </aside>

          <section className="chats-inbox">
            <div className="chats-inbox-header">
              <select
                value={selectedSessionId}
                onChange={e => setSelectedSessionId(e.target.value)}
                className="chats-workspace-select"
                title="Active workspace"
              >
                {sessions.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.phone || t('chats.noPhone')})
                  </option>
                ))}
              </select>
              <div className="chats-channel-filter" ref={channelMenuRef}>
                <button
                  type="button"
                  className="chats-inbox-channel"
                  onClick={() => setShowChannelMenu(v => !v)}
                  aria-expanded={showChannelMenu}
                >
                  {selectedChannelIds.length === sessions.length
                    ? 'All channels'
                    : `${selectedChannelIds.length} channel${selectedChannelIds.length === 1 ? '' : 's'}`}
                  <ChevronDown size={16} />
                </button>
                {showChannelMenu && (
                  <div className="chats-channel-menu">
                    <div className="chats-channel-menu-header">
                      <span>All channels</span>
                      <span>{sessions.length}</span>
                    </div>
                    {sessions.map(s => {
                      const checked = selectedChannelIds.includes(s.id);
                      return (
                        <label key={s.id} className="chats-channel-menu-item">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleChannelSelection(s.id)}
                          />
                          <span className="chats-channel-menu-name">{s.name}</span>
                          <span className="chats-channel-menu-phone">{s.phone || t('chats.noPhone')}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="chats-inbox-toolbar">
              <div className="chat-search-input">
                <Search size={18} />
                <input
                  ref={inboxSearchRef}
                  type="text"
                  placeholder={t('chats.searchPlaceholder')}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  aria-label={t('chats.searchPlaceholder')}
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

            {/* Label filter — only shown once at least one label exists. */}
            {allLabels.length > 0 && (
              <div className="chats-label-filter" role="group" aria-label="Filter by label">
                <button
                  type="button"
                  className={`label-filter-chip${labelFilterId === '' ? ' active' : ''}`}
                  onClick={() => setLabelFilterId('')}
                >
                  All
                </button>
                {allLabels.map(label => (
                  <button
                    key={label.id}
                    type="button"
                    className={`label-filter-chip${labelFilterId === label.id ? ' active' : ''}`}
                    style={
                      labelFilterId === label.id
                        ? { background: label.color, borderColor: label.color, color: '#fff' }
                        : { borderColor: label.color, color: label.color }
                    }
                    onClick={() => setLabelFilterId(id => (id === label.id ? '' : label.id))}
                  >
                    {label.name}
                  </button>
                ))}
              </div>
            )}

            {/* Non-blocking notice: a selected channel failed to load — the rest still show. */}
            {failedChannelIds.length > 0 && (
              <div className="chats-channel-warning" role="status">
                <AlertCircle size={14} />
                <span>
                  {t('chats.channelLoadFailed', {
                    defaultValue: "Couldn't load {{names}}. Showing the other channels.",
                    names: failedChannelIds
                      .map(fid => sessions.find(s => s.id === fid)?.name || fid)
                      .join(', '),
                  })}
                </span>
                <button type="button" onClick={() => void loadChats(selectedChannelIds)}>
                  {t('common.refresh')}
                </button>
              </div>
            )}

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
                  // Identity is per-channel: the same contact/group can exist on multiple WhatsApp
                  // accounts, so both the key and the active check combine sessionId + chat.id.
                  const isActive = activeChat?.id === chat.id && activeChat?.sessionId === chat.sessionId;
                  return (
                    <ChatRow
                      key={`${chat.sessionId}:${chat.id}`}
                      chat={chat}
                      isActive={isActive}
                      searchQuery={searchQuery}
                      yesterdayLabel={t('chats.yesterday')}
                      noMessageLabel={t('chats.noMessageYet')}
                      labels={chatLabelMap[`${chat.sessionId}::${chat.id}`] ?? []}
                      onSelect={() => setActiveChat(chat)}
                    />
                  );
                })
              )}
            </div>
          </section>

          <main className="chats-room">
            {activeChat ? (
              <div className="room-container">
                <ConversationHeader
                  chat={activeChat}
                  statusLabel={isConnected ? 'Connected' : 'Waiting for sync'}
                  statusOk={isConnected}
                  showInfo={showInfo}
                  onSearchClick={() => inboxSearchRef.current?.focus()}
                  onToggleInfo={() => setShowInfo(v => !v)}
                  onMoreClick={() => setShowInfo(true)}
                />

                <div className="room-messages" onScroll={handleMessagesScroll}>
                  {!loadingMessages && messages.length > 0 && !reachedOldest && (
                    <div className="load-older-row">
                      <button
                        type="button"
                        className="load-older-btn"
                        onClick={() => void loadOlderMessages()}
                        disabled={loadingOlder}
                      >
                        {loadingOlder ? (
                          <>
                            <Loader2 className="animate-spin" size={14} />
                            {t('chats.loadingMessages')}
                          </>
                        ) : (
                          t('chats.loadOlder', { defaultValue: 'Load older messages' })
                        )}
                      </button>
                    </div>
                  )}
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
                    renderItems.map(item => {
                      if (item.kind === 'separator') {
                        return <DateSeparator key={item.key} label={item.label} />;
                      }
                      const { msg, isGrouped, showSenderName } = item;
                      const isMe = msg.direction === 'outgoing';
                      const formattedTime = formatTime(
                        msg.timestamp || Math.floor(new Date(msg.createdAt).getTime() / 1000),
                      );
                      return (
                        <MessageBubble
                          key={item.key}
                          msg={msg}
                          isMe={isMe}
                          formattedTime={formattedTime}
                          showSenderName={showSenderName}
                          senderLabel={msg.from}
                          isGrouped={isGrouped}
                          isHighlighted={highlightedMessageId === msg.id}
                          mediaDownloadStatus={mediaDownloads[msg.id] ?? 'idle'}
                          unsupportedLabel={t('chats.unsupportedMessage', { defaultValue: 'Unsupported message type' })}
                          mediaMessageLabel={t('chats.mediaMessage', { defaultValue: 'Media message' })}
                          deletedLabel={t('chats.messageDeleted')}
                          downloadDocumentLabel={t('chats.downloadDocument')}
                          onDownloadMedia={() => void handleDownloadMedia(msg)}
                          onReply={() => setReplyingTo(msg)}
                          onReact={emoji => void handleReactMessage(msg, emoji)}
                          onDelete={() => void handleDeleteMessage(msg)}
                          onJumpToQuoted={handleJumpToQuoted}
                          replyLabel={t('chats.actions.reply')}
                          reactLabel={t('chats.actions.react')}
                          deleteLabel={t('chats.actions.delete')}
                        />
                      );
                    })
                  )}
                  <div ref={chatBottomRef} />
                </div>

                <Composer
                  canWrite={canWrite}
                  sending={sending}
                  messageInput={messageInput}
                  attachment={attachment}
                  previewUrl={previewUrl}
                  showEmojiPicker={showEmojiPicker}
                  replyingTo={replyingTo}
                  replyingToTitle={t('chats.replyingTo', {
                    name: replyingTo?.direction === 'outgoing' ? t('chats.you') : formatContactDisplay(activeChat.name, activeChat.id),
                  })}
                  replyingToBody={replyingTo ? (replyingTo.type !== 'text' ? `[${replyingTo.type}]` : replyingTo.body) : ''}
                  popularEmojis={POPULAR_EMOJIS}
                  attachTitle={t('chats.attachTitle')}
                  emojiTitle={t('chats.emojiTitle')}
                  messagePlaceholder={t('chats.messagePlaceholder')}
                  captionPlaceholder={t('chats.captionPlaceholder')}
                  noPermissionPlaceholder={t('chats.noPermission')}
                  sendLabel={t('chats.send')}
                  onMessageInputChange={setMessageInput}
                  onSend={handleSend}
                  onTriggerFileSelect={triggerFileSelect}
                  onFileChange={handleFileChange}
                  onRemoveAttachment={handleRemoveAttachment}
                  onToggleEmojiPicker={() => setShowEmojiPicker(v => !v)}
                  onEmojiClick={handleEmojiClick}
                  onCloseReply={() => setReplyingTo(null)}
                  fileInputRef={fileInputRef}
                />
              </div>
            ) : (
              <div className="chats-room-placeholder">
                <div className="chats-room-placeholder-orb">
                  <MessageSquare size={80} className="placeholder-icon" />
                </div>
                <h2>Select a conversation</h2>
                <p>Pick a thread from the inbox to start replying, reviewing context, and handling WhatsApp chats faster.</p>
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

          {/* Chat Info — persistent right column on desktop, slide-over on tablet/mobile.
              Built entirely from in-memory data (no fetching). */}
          {showInfo && activeChat && (
            <InfoPanel
              chat={activeChat}
              phone={activeChatPhone}
              channelName={selectedChannelName}
              channelPhone={activeChannelPhone}
              isConnected={isConnected}
              connectedLabel="Connected"
              reconnectingLabel="Reconnecting"
              lastActivityLabel={activeChat.timestamp ? formatChatTime(activeChat.timestamp, t('chats.yesterday')) : ''}
              unreadCount={activeChatUnread}
              loadedCount={activeChatMessageCount}
              totalCount={messagesTotal}
              incomingCount={messageStats.incoming}
              outgoingCount={messageStats.outgoing}
              mediaCount={messageStats.media}
              noPhoneLabel={t('chats.noPhone')}
              onClose={() => setShowInfo(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}
