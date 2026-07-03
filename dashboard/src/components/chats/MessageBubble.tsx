import { memo } from 'react';
import { CornerUpLeft, Smile, Trash2 } from 'lucide-react';
import type { ChatMessageView, MediaDownloadStatus } from './types';
import {
  DOWNLOADABLE_MEDIA_TYPES,
  QUOTE_MEDIA_LABELS,
  QuotedMediaIcon,
  renderTextWithLinks,
} from './helpers';
import { MediaCard, MediaDownloadPlaceholder } from './MediaCard';
import { ReplyCard } from './ReplyCard';

const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

interface MessageBubbleProps {
  msg: ChatMessageView;
  isMe: boolean;
  formattedTime: string;
  showSenderName: boolean; // groups only, and only on the first message of a consecutive run
  senderLabel?: string;
  isGrouped: boolean; // suppress extra top margin when grouped with the previous message
  isHighlighted: boolean; // brief flash when jumped-to via a reply click
  mediaDownloadStatus: MediaDownloadStatus | 'idle';
  unsupportedLabel: string;
  mediaMessageLabel: string;
  deletedLabel: string;
  downloadDocumentLabel: string;
  onDownloadMedia: () => void;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onDelete: () => void;
  onJumpToQuoted: (quotedId: string) => void;
  replyLabel: string;
  reactLabel: string;
  deleteLabel: string;
}

// A single chat bubble: incoming (left, light/glass) or outgoing (right, WhatsApp green) with
// delivery ticks + timestamp inside the bubble, optional sender name (groups), quoted-reply card,
// typed media, reactions, and a hover action menu (reply / react / delete).
export const MessageBubble = memo(function MessageBubble({
  msg,
  isMe,
  formattedTime,
  showSenderName,
  senderLabel,
  isGrouped,
  isHighlighted,
  mediaDownloadStatus,
  unsupportedLabel,
  mediaMessageLabel,
  deletedLabel,
  downloadDocumentLabel,
  onDownloadMedia,
  onReply,
  onReact,
  onDelete,
  onJumpToQuoted,
  replyLabel,
  reactLabel,
  deleteLabel,
}: MessageBubbleProps) {
  const isMediaMessage = msg.type !== 'text';
  const mediaInfo = msg.metadata?.media;
  const isRevoked = msg.type === 'revoked';
  const quotedBody = msg.metadata?.quotedMessage?.body;
  const quotedId = msg.metadata?.quotedMessage?.id;
  const reactions = msg.metadata?.reactions || {};
  const hasReactions = Object.keys(reactions).length > 0;
  const hasMediaPayload = !!mediaInfo && !!mediaInfo.data;

  const hasTextBody = !!msg.body && (!mediaInfo || msg.body !== mediaInfo.filename);
  // Any message that carries media metadata is downloadable, even when its type is
  // odd/legacy ('unknown', engine-specific tokens) — otherwise real media rendered
  // as a dead "Media message" label with no way to load it.
  const needsMediaDownload = !hasMediaPayload && !isRevoked && (DOWNLOADABLE_MEDIA_TYPES.has(msg.type) || !!mediaInfo);

  return (
    <div
      id={`msg-${msg.id}`}
      className={`message-bubble-wrapper ${isMe ? 'outgoing' : 'incoming'} ${isGrouped ? 'grouped' : ''} ${
        isHighlighted ? 'highlighted' : ''
      }`}
    >
      <div className="message-bubble-container">
        <div
          className={`message-bubble ${isMe ? 'outgoing' : 'incoming'} ${msg.status} ${
            isMediaMessage ? 'media-type' : ''
          } ${msg.type === 'sticker' ? 'sticker-type' : ''} ${isRevoked ? 'revoked-type' : ''}`}
        >
          {showSenderName && senderLabel && <div className="message-sender-name">{senderLabel}</div>}

          {msg.metadata?.quotedMessage && (
            <ReplyCard body={quotedBody || ''} onClick={() => quotedId && onJumpToQuoted(quotedId)} />
          )}

          {(() => {
            if (isRevoked) {
              return <div className="message-text message-deleted">{deletedLabel}</div>;
            }

            const renderedMedia = hasMediaPayload ? (
              <MediaCard msg={msg} downloadLabel={downloadDocumentLabel} />
            ) : null;

            if (renderedMedia || needsMediaDownload || hasTextBody) {
              return (
                <>
                  {renderedMedia}
                  {needsMediaDownload && (
                    <MediaDownloadPlaceholder
                      type={msg.type}
                      media={mediaInfo}
                      status={mediaDownloadStatus}
                      onDownload={onDownloadMedia}
                    />
                  )}
                  {hasTextBody && <div className="message-text">{renderTextWithLinks(msg.body)}</div>}
                </>
              );
            }
            // A non-text type with no renderable media and no body (e.g. an empty
            // location/contact/unknown): still show its kind, never "unsupported".
            if (isMediaMessage) {
              const label = QUOTE_MEDIA_LABELS[msg.type] || mediaMessageLabel;
              return (
                <div className="message-media-placeholder">
                  <QuotedMediaIcon type={msg.type} />
                  <span>{label}</span>
                </div>
              );
            }
            // Truly nothing to show: no media, no text, unknown type.
            return <div className="message-text message-unsupported">{unsupportedLabel}</div>;
          })()}

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

        {!isRevoked && (
          <div className="message-actions-menu">
            <button type="button" className="action-btn" onClick={onReply} title={replyLabel} aria-label={replyLabel}>
              <CornerUpLeft size={14} />
            </button>

            <div className="reaction-trigger-wrapper">
              <button type="button" className="action-btn reaction-btn" title={reactLabel} aria-label={reactLabel}>
                <Smile size={14} />
              </button>
              <div className="reaction-quick-popover">
                {REACTION_EMOJIS.map(emoji => (
                  <button key={emoji} type="button" onClick={() => onReact(emoji)}>
                    {emoji}
                  </button>
                ))}
              </div>
            </div>

            {isMe && msg.status !== 'pending' && (
              <button
                type="button"
                className="action-btn delete-btn"
                onClick={onDelete}
                title={deleteLabel}
                aria-label={deleteLabel}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
