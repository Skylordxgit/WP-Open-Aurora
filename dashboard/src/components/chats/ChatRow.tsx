import { memo } from 'react';
import { Users, User } from 'lucide-react';
import type { ChatWithSession } from './types';
import type { Label } from '../../services/api';
import { formatChatTime, highlightMatch, formatContactDisplay, messagePreviewFallback } from './helpers';
import { LabelChip } from './LabelChip';

interface ChatRowProps {
  chat: ChatWithSession;
  isActive: boolean;
  searchQuery: string;
  yesterdayLabel: string;
  noMessageLabel: string;
  labels?: Label[];
  onSelect: () => void;
}

// A single dense, WhatsApp-Desktop-style chat list row (~68px): avatar, name, last-message
// preview, time, unread badge, channel badge, label chips, and a selection indicator.
export const ChatRow = memo(function ChatRow({
  chat,
  isActive,
  searchQuery,
  yesterdayLabel,
  noMessageLabel,
  labels = [],
  onSelect,
}: ChatRowProps) {
  const displayName = formatContactDisplay(chat.displayName ?? chat.name, chat.id);
  // Body text wins; media/deleted messages have no body, so fall back to a typed
  // preview ("📷 Photo", "🎤 Voice message", …) like WhatsApp Web.
  const snippet = chat.lastMessage || messagePreviewFallback(chat.lastMessageType);
  const visibleLabels = labels.slice(0, 2);
  const extraLabels = labels.length - visibleLabels.length;

  return (
    <div
      className={`chat-item-card ${isActive ? 'active' : ''} ${(chat.unreadCount || 0) > 0 ? 'has-unread' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="chat-avatar">{chat.isGroup ? <Users size={20} /> : <User size={20} />}</div>

      <div className="chat-item-info">
        <div className="chat-item-top">
          <span className="chat-item-name" title={chat.name || chat.id}>
            {highlightMatch(displayName, searchQuery)}
          </span>
          {chat.timestamp ? (
            <span className="chat-item-time">{formatChatTime(chat.timestamp, yesterdayLabel)}</span>
          ) : null}
        </div>
        <div className="chat-item-bottom">
          <span className="chat-item-snippet" title={snippet}>
            {snippet ? highlightMatch(snippet, searchQuery) : <span className="no-message">{noMessageLabel}</span>}
          </span>
          <div className="chat-item-badges">
            {chat.unreadCount > 0 && <span className="chat-unread-badge">{chat.unreadCount}</span>}
          </div>
        </div>
        {labels.length > 0 && (
          <div className="chat-item-labels">
            {visibleLabels.map(l => (
              <LabelChip key={l.id} label={l} />
            ))}
            {extraLabels > 0 && <span className="chat-item-labels-more">+{extraLabels}</span>}
          </div>
        )}
      </div>
    </div>
  );
});
