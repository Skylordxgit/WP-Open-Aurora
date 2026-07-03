import type { ReactNode } from 'react';
import { Image as ImageIcon, Film, Music, Mic, FileText } from 'lucide-react';
import type { MessageMedia } from './types';

// Map an attachment MIME type to the neutral MessageType for the optimistic outgoing bubble, so the
// placeholder matches what the backend will persist (e.g. a PDF is `document`, not `application`).
export const messageTypeFromMime = (mimetype: string) => {
  if (mimetype.startsWith('image/')) return 'image' as const;
  if (mimetype.startsWith('video/')) return 'video' as const;
  if (mimetype.startsWith('audio/')) return 'audio' as const;
  return 'document' as const;
};

export const getMediaSrc = (media?: MessageMedia): string => {
  if (!media || !media.data) return '';
  if (media.data.startsWith('data:') || media.data.startsWith('http://') || media.data.startsWith('https://')) {
    return media.data;
  }
  return `data:${media.mimetype};base64,${media.data}`;
};

// Derive an uppercase file extension from a filename for the document chip badge. Presentation
// only — does not alter the stored filename or media data.
export const getFileExtension = (filename?: string): string => {
  if (!filename) return '';
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toUpperCase();
};

// Human-readable byte size (e.g. "1.4 MB") for media cards. Presentation only.
export const formatBytes = (bytes?: number): string => {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

// Approximate base64 payload size in bytes (no padding correction needed for display purposes).
export const estimateBase64Bytes = (base64?: string): number => {
  if (!base64) return 0;
  return Math.floor((base64.length * 3) / 4);
};

// Human-readable clock duration (e.g. "0:07", "1:23", "1:02:05") for voice/audio/video media cards.
// Presentation only.
export const formatDuration = (seconds?: number): string => {
  if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
};

// If a quoted preview body is a bare media marker like "[image]", return the media kind so the UI
// can show an icon + readable label instead of literal brackets. Uses only the existing body.
export const getQuotedMediaType = (body?: string): string | null => {
  if (!body) return null;
  const match = body.trim().match(/^\[(image|video|audio|voice|document|sticker)\]$/i);
  return match ? match[1].toLowerCase() : null;
};

// Turn URLs inside displayed message text into safe new-tab links. This transforms only what is
// rendered (no innerHTML, no change to the stored/sent body). `pre-wrap` on .message-text keeps
// the original line breaks in the plain-text segments.
const URL_PATTERN = /(https?:\/\/[^\s]+)/g;
export const renderTextWithLinks = (text: string): ReactNode => {
  if (!text) return text;
  return text.split(URL_PATTERN).map((segment, index) =>
    /^https?:\/\//.test(segment) ? (
      <a key={index} href={segment} target="_blank" rel="noopener noreferrer">
        {segment}
      </a>
    ) : (
      segment
    ),
  );
};

// Icon for a quoted media marker (see getQuotedMediaType). Kept here so renderers stay tidy.
export const QuotedMediaIcon = ({ type }: { type: string }) => {
  switch (type) {
    case 'image':
    case 'sticker':
      return <ImageIcon size={13} />;
    case 'video':
      return <Film size={13} />;
    case 'audio':
      return <Music size={13} />;
    case 'voice':
      return <Mic size={13} />;
    case 'document':
    default:
      return <FileText size={13} />;
  }
};

export const QUOTE_MEDIA_LABELS: Record<string, string> = {
  image: 'Photo',
  video: 'Video',
  audio: 'Audio',
  voice: 'Voice message',
  document: 'Document',
  sticker: 'Sticker',
};

// Message types whose bytes can be downloaded on demand. History media is NOT auto-downloaded;
// these rows render a placeholder + "Download" action and only fetch when the user clicks.
export const DOWNLOADABLE_MEDIA_TYPES = new Set<string>([
  'image',
  'video',
  'audio',
  'voice',
  'document',
  'sticker',
]);

// WhatsApp-style "<kind> available" labels shown on the not-yet-downloaded media placeholder.
export const MEDIA_AVAILABLE_LABELS: Record<string, string> = {
  image: 'Image available',
  video: 'Video available',
  audio: 'Audio available',
  voice: 'Voice message available',
  document: 'Document available',
  sticker: 'Sticker available',
};

// Strip the WhatsApp JID suffix (@c.us / @lid / @s.whatsapp.net / @g.us / @newsletter)
// for display. Presentation only — never mutates stored ids.
export const stripJidSuffix = (id: string): string => (id ? id.split('@')[0] : '');

export const UNKNOWN_CONTACT_LABEL = 'Unknown Contact';

// Junk values that must never be shown as a contact identity (engines sometimes
// hand back "0", "Number", etc. for unknown contacts).
const JUNK_NAMES = new Set(['', '0', 'number', 'null', 'undefined', 'unknown']);
const cleanName = (name: string | null | undefined): string => {
  const t = (name ?? '').trim();
  if (JUNK_NAMES.has(t.toLowerCase())) return '';
  // A raw JID is never a real contact name — the stored-chat fallback uses the
  // chatId as `name`, so reject anything containing '@' (e.g. "…@lid", "…@c.us").
  if (t.includes('@')) return '';
  return t;
};

// Render a digits string as a phone number (e.g. "+919702546146"); empty for
// missing / all-zero values so callers fall through to "Unknown Contact".
export const formatPhoneDigits = (value: string | null | undefined): string => {
  const d = (value ?? '').replace(/\D/g, '');
  return d && !/^0+$/.test(d) ? `+${d}` : '';
};

// Human label for the chat kind, from the JID suffix.
export const chatType = (id: string): 'Direct' | 'Group' | 'Broadcast' => {
  if (!id) return 'Direct';
  if (id.endsWith('@g.us')) return 'Group';
  if (id.endsWith('@broadcast')) return 'Broadcast';
  return 'Direct';
};

const asNameOrPhone = (value: string): string => {
  if (/^\d+$/.test(value)) return formatPhoneDigits(value) || UNKNOWN_CONTACT_LABEL;
  return value;
};

// Single source of truth for how a contact/chat is displayed across the entire
// app (Chats list/header/info, dashboard analytics, bulk results, pickers).
// Priority: resolved contact name → phone number → "Unknown Contact". A raw
// `@lid` / `@c.us` / `@s.whatsapp.net` suffix, a bare LID number, or junk values
// like "0"/"Number" are NEVER rendered. Reused everywhere; do not duplicate.
export const formatContactDisplay = (name: string | null | undefined, id: string): string => {
  const resolved = cleanName(name);
  const local = stripJidSuffix(id);

  if (id && id.endsWith('@g.us')) return resolved ? asNameOrPhone(resolved) : 'Group';
  if (id && id.endsWith('@broadcast')) return resolved ? asNameOrPhone(resolved) : 'Broadcast';

  if (id && id.includes('@lid')) {
    // The LID itself is never a contact identity. Only a resolved name/phone
    // (different from the bare LID) may be shown; otherwise "Unknown Contact".
    if (resolved && resolved !== local) return asNameOrPhone(resolved);
    return UNKNOWN_CONTACT_LABEL;
  }

  // Direct / unknown JID: a real name (not just the bare id) wins.
  if (resolved && resolved !== local) return asNameOrPhone(resolved);
  // Otherwise fall back to the phone encoded in the JID local part.
  return formatPhoneDigits(local) || UNKNOWN_CONTACT_LABEL;
};

// WhatsApp-Web-style preview text for a message with an empty body, from its
// neutral type. Returns '' for text/unknown so callers fall through to their
// own "no message" placeholder.
export const MESSAGE_TYPE_PREVIEWS: Record<string, string> = {
  image: '📷 Photo',
  video: '🎥 Video',
  audio: '🎵 Audio',
  voice: '🎤 Voice message',
  ptt: '🎤 Voice message',
  sticker: '💟 Sticker',
  document: '📄 Document',
  location: '📍 Location',
  contact: '👤 Contact',
  revoked: 'This message was deleted',
};

export const messagePreviewFallback = (type?: string): string =>
  (type && MESSAGE_TYPE_PREVIEWS[type]) || '';

export const formatTime = (timestamp?: number) => {
  if (!timestamp) return '';
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export const formatChatTime = (timestamp: number | undefined, yesterdayLabel: string) => {
  if (!timestamp) return '';
  const date = new Date(timestamp * 1000);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return yesterdayLabel;
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

// Date-separator label ("Today" / "Yesterday" / actual date) for grouping messages by day.
export const formatDateSeparator = (timestamp: number, todayLabel: string, yesterdayLabel: string): string => {
  const date = new Date(timestamp * 1000);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return todayLabel;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return yesterdayLabel;
  return date.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
};

// Highlights occurrences of `query` inside `text` for search-result rendering. Case-insensitive,
// safe against regex metacharacters in the query.
export const highlightMatch = (text: string, query: string): ReactNode => {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  if (parts.length === 1) return text;
  return parts.map((part, idx) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={idx} className="chat-highlight">
        {part}
      </mark>
    ) : (
      part
    ),
  );
};
