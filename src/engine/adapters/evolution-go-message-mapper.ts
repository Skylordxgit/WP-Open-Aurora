import {
  DeliveryStatus,
  EditedMessage,
  IncomingMessage,
  MessageType,
  ReactionEvent,
  RevokedMessage,
} from '../interfaces/whatsapp-engine.interface';

type JsonRecord = Record<string, unknown>;

const MEDIA_KEYS: Array<{
  keys: string[];
  type: MessageType;
}> = [
  { keys: ['imageMessage', 'ImageMessage'], type: 'image' },
  { keys: ['videoMessage', 'VideoMessage'], type: 'video' },
  { keys: ['audioMessage', 'AudioMessage'], type: 'audio' },
  { keys: ['documentMessage', 'DocumentMessage'], type: 'document' },
  { keys: ['stickerMessage', 'StickerMessage'], type: 'sticker' },
];

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function first(value: JsonRecord | undefined, ...keys: string[]): unknown {
  if (!value) return undefined;
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key];
  }
  return undefined;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

function bool(value: unknown): boolean {
  return value === true || value === 'true';
}

function unixSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return unixSeconds(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  const seconds = first(record(value), 'seconds', 'Seconds', 'low', 'Low');
  if (seconds !== undefined) return unixSeconds(seconds);
  return Math.floor(Date.now() / 1000);
}

/** Remove device addressing and expose the same neutral JID vocabulary used by the existing UI. */
export function toNeutralWhatsAppId(value: unknown): string {
  const raw = text(value).trim();
  if (!raw) return '';

  const at = raw.indexOf('@');
  if (at < 0) return raw.replace(/:\d+$/, '');
  const user = raw.slice(0, at).replace(/:\d+$/, '');
  const server = raw.slice(at + 1).toLowerCase();
  if (server === 's.whatsapp.net') return `${user}@c.us`;
  return `${user}@${server}`;
}

/** Convert Aurora's neutral direct-chat suffix back to the JID expected by Evolution Go. */
export function toEvolutionWhatsAppId(value: string): string {
  const normalized = value.trim();
  if (!normalized.includes('@')) return normalized.replace(/\D/g, '');
  if (normalized.endsWith('@c.us')) return `${normalized.slice(0, -5)}@s.whatsapp.net`;
  return normalized;
}

function messageContainer(data: JsonRecord): JsonRecord {
  return record(first(data, 'Message', 'message')) ?? data;
}

function mediaPart(message: JsonRecord): { value: JsonRecord; type: MessageType } | undefined {
  for (const candidate of MEDIA_KEYS) {
    const value = record(first(message, ...candidate.keys));
    if (value) {
      const isVoice = candidate.type === 'audio' && bool(first(value, 'PTT', 'ptt'));
      return { value, type: isVoice ? 'voice' : candidate.type };
    }
  }
  return undefined;
}

function bodyAndType(message: JsonRecord): { body: string; type: MessageType } {
  const conversation = text(first(message, 'conversation', 'Conversation'));
  if (conversation) return { body: conversation, type: 'text' };

  const extended = record(first(message, 'extendedTextMessage', 'ExtendedTextMessage'));
  if (extended) return { body: text(first(extended, 'text', 'Text')), type: 'text' };

  const media = mediaPart(message);
  if (media) {
    return {
      body: text(first(media.value, 'caption', 'Caption', 'fileName', 'FileName')),
      type: media.type,
    };
  }

  const location = record(first(message, 'locationMessage', 'LocationMessage'));
  if (location) {
    return {
      body: text(first(location, 'name', 'Name', 'address', 'Address')),
      type: 'location',
    };
  }

  const liveLocation = record(first(message, 'liveLocationMessage', 'LiveLocationMessage'));
  if (liveLocation) {
    return {
      body: text(first(liveLocation, 'caption', 'Caption')),
      type: 'location',
    };
  }

  const contact = record(first(message, 'contactMessage', 'ContactMessage'));
  const contacts = first(message, 'contactsArrayMessage', 'ContactsArrayMessage');
  if (contact || contacts) {
    return {
      body: text(first(contact, 'displayName', 'DisplayName')),
      type: 'contact',
    };
  }

  const protocol = record(first(message, 'protocolMessage', 'ProtocolMessage'));
  if (protocol) {
    const protocolType = text(first(protocol, 'type', 'Type')).toUpperCase();
    if (protocolType.includes('REVOKE') || protocolType === '0') return { body: '', type: 'revoked' };
  }

  return { body: '', type: 'unknown' };
}

function contextInfo(message: JsonRecord): JsonRecord | undefined {
  const candidates = [
    record(first(message, 'extendedTextMessage', 'ExtendedTextMessage')),
    mediaPart(message)?.value,
    record(first(message, 'locationMessage', 'LocationMessage')),
    record(first(message, 'contactMessage', 'ContactMessage')),
  ];
  for (const candidate of candidates) {
    const context = record(first(candidate, 'contextInfo', 'ContextInfo'));
    if (context) return context;
  }
  return undefined;
}

function quotedMessage(data: JsonRecord, message: JsonRecord): IncomingMessage['quotedMessage'] {
  const outer = record(first(data, 'quoted', 'Quoted'));
  const context = contextInfo(message);
  const id = text(first(outer, 'stanzaID', 'stanzaId', 'StanzaID')) || text(first(context, 'stanzaID', 'stanzaId'));
  const quoted =
    record(first(outer, 'quotedMessage', 'QuotedMessage')) ?? record(first(context, 'quotedMessage', 'QuotedMessage'));
  if (!id || !quoted) return undefined;
  return { id, body: bodyAndType(quoted).body };
}

function location(message: JsonRecord): IncomingMessage['location'] {
  const value =
    record(first(message, 'locationMessage', 'LocationMessage')) ??
    record(first(message, 'liveLocationMessage', 'LiveLocationMessage'));
  if (!value) return undefined;
  const latitude = Number(first(value, 'degreesLatitude', 'DegreesLatitude', 'latitude', 'Latitude'));
  const longitude = Number(first(value, 'degreesLongitude', 'DegreesLongitude', 'longitude', 'Longitude'));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  return {
    latitude,
    longitude,
    description: text(first(value, 'name', 'Name', 'caption', 'Caption')) || undefined,
    address: text(first(value, 'address', 'Address')) || undefined,
    url: text(first(value, 'url', 'URL')) || undefined,
  };
}

function media(data: JsonRecord, message: JsonRecord): IncomingMessage['media'] {
  const part = mediaPart(message);
  if (!part) return undefined;
  const mimetype =
    text(first(message, 'mimetype', 'Mimetype')) ||
    text(first(part.value, 'mimetype', 'Mimetype')) ||
    defaultMimetype(part.type);
  return {
    mimetype,
    filename: text(first(part.value, 'fileName', 'FileName', 'fileNameWithoutExtension')) || undefined,
    data: text(first(message, 'base64', 'Base64')) || undefined,
    url: text(first(message, 'mediaUrl', 'MediaURL', 'mediaURL')) || undefined,
  };
}

function defaultMimetype(type: MessageType): string {
  if (type === 'image') return 'image/jpeg';
  if (type === 'video') return 'video/mp4';
  if (type === 'audio' || type === 'voice') return 'audio/ogg';
  if (type === 'sticker') return 'image/webp';
  return 'application/octet-stream';
}

function mentionedIds(message: JsonRecord): string[] | undefined {
  const ids = first(contextInfo(message), 'mentionedJID', 'mentionedJid', 'MentionedJID');
  if (!Array.isArray(ids)) return undefined;
  const normalized = ids.map(toNeutralWhatsAppId).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

/** Map an Evolution Go Message/SendMessage event (or its data object) into Aurora's stable contract. */
export function mapEvolutionMessage(payload: unknown, selfJid = ''): IncomingMessage | null {
  const envelope = record(payload);
  const data = record(first(envelope, 'data', 'Data')) ?? envelope;
  if (!data) return null;
  const info = record(first(data, 'Info', 'info'));
  const message = messageContainer(data);
  const id = text(first(info, 'ID', 'id')) || text(first(data, 'id', 'messageId', 'MessageID'));
  if (!id) return null;

  const chat = toNeutralWhatsAppId(first(info, 'Chat', 'chat'));
  const sender = toNeutralWhatsAppId(first(info, 'Sender', 'sender'));
  const senderAlt = toNeutralWhatsAppId(first(info, 'SenderAlt', 'senderAlt'));
  const fromMe = bool(first(info, 'IsFromMe', 'isFromMe', 'fromMe'));
  const isGroup = bool(first(info, 'IsGroup', 'isGroup')) || chat.endsWith('@g.us');
  const normalizedSelf = toNeutralWhatsAppId(selfJid);
  const directSender = sender || chat;
  const author = isGroup && !fromMe ? directSender : undefined;
  const { body, type } = bodyAndType(message);
  const resolvedSender = directSender.endsWith('@lid') && senderAlt.endsWith('@c.us') ? senderAlt : directSender;
  const isLidSender = resolvedSender.endsWith('@lid');
  const senderPhone = !isLidSender && resolvedSender.endsWith('@c.us') ? resolvedSender.split('@')[0] : undefined;

  return {
    id,
    chatId: chat || resolvedSender,
    from: fromMe ? normalizedSelf : isGroup ? chat : resolvedSender,
    to: fromMe ? chat || resolvedSender : normalizedSelf,
    body,
    type,
    timestamp: unixSeconds(first(info, 'Timestamp', 'timestamp')),
    fromMe,
    isGroup,
    isStatusBroadcast: (chat || resolvedSender).endsWith('@broadcast'),
    author,
    mentionedIds: mentionedIds(message),
    isLidSender,
    senderPhone: isLidSender ? null : senderPhone,
    contact: {
      pushName: text(first(info, 'PushName', 'pushName')) || undefined,
      name: text(first(data, 'contactName', 'ContactName')) || undefined,
    },
    media: media(data, message),
    quotedMessage: quotedMessage(data, message),
    location: location(message),
  };
}

export function mapEvolutionReceipt(payload: unknown): { ids: string[]; status: DeliveryStatus } | null {
  const envelope = record(payload);
  const data = record(first(envelope, 'data', 'Data')) ?? envelope;
  if (!data) return null;
  const rawIds = first(data, 'MessageIDs', 'messageIDs', 'messageIds', 'ids');
  const ids = Array.isArray(rawIds) ? rawIds.map(text).filter(Boolean) : [text(rawIds)].filter(Boolean);
  if (ids.length === 0) return null;
  const state = text(first(envelope, 'state', 'State', 'status')) || text(first(data, 'Type', 'type', 'state'));
  const normalized = state.toLowerCase();
  const status: DeliveryStatus = normalized.includes('read')
    ? 'read'
    : normalized.includes('deliver')
      ? 'delivered'
      : normalized.includes('fail')
        ? 'failed'
        : 'sent';
  return { ids, status };
}

export function mapEvolutionReaction(payload: unknown): ReactionEvent | null {
  const message = mapEvolutionMessage(payload);
  const envelope = record(payload);
  const data = record(first(envelope, 'data', 'Data')) ?? envelope;
  const content = data ? messageContainer(data) : undefined;
  const reaction = record(first(content, 'reactionMessage', 'ReactionMessage'));
  const key = record(first(reaction, 'key', 'Key'));
  const messageId = text(first(key, 'ID', 'id'));
  if (!messageId || !reaction) return null;
  return {
    messageId,
    chatId: message?.chatId ?? toNeutralWhatsAppId(first(key, 'remoteJID', 'remoteJid')),
    reaction: text(first(reaction, 'text', 'Text')),
    senderId: message?.author ?? message?.from ?? '',
  };
}

export function mapEvolutionRevocation(payload: unknown): RevokedMessage | null {
  const envelope = record(payload);
  const data = record(first(envelope, 'data', 'Data')) ?? envelope;
  if (!data) return null;
  const info = record(first(data, 'Info', 'info'));
  const content = messageContainer(data);
  const protocol = record(first(content, 'protocolMessage', 'ProtocolMessage'));
  const protocolType = text(first(protocol, 'type', 'Type')).toUpperCase();
  if (!protocol || (!protocolType.includes('REVOKE') && protocolType !== '0')) return null;
  const key = record(first(protocol, 'key', 'Key'));
  const id = text(first(key, 'ID', 'id'));
  if (!id) return null;
  const chatId = toNeutralWhatsAppId(first(info, 'Chat', 'chat'));
  return {
    id,
    chatId,
    from: toNeutralWhatsAppId(first(info, 'Sender', 'sender')),
    to: chatId,
    type: 'revoked',
    body: '',
    timestamp: unixSeconds(first(info, 'Timestamp', 'timestamp')),
  };
}

/** Map WhatsApp's protocol wrapper for an edited text message to the original message id. */
export function mapEvolutionEdit(payload: unknown): EditedMessage | null {
  const envelope = record(payload);
  const data = record(first(envelope, 'data', 'Data')) ?? envelope;
  if (!data) return null;
  const info = record(first(data, 'Info', 'info'));
  const content = messageContainer(data);
  const protocol = record(first(content, 'protocolMessage', 'ProtocolMessage'));
  const protocolType = text(first(protocol, 'type', 'Type')).toUpperCase();
  if (!protocol || (!protocolType.includes('MESSAGE_EDIT') && protocolType !== '14')) return null;

  const key = record(first(protocol, 'key', 'Key'));
  const edited = record(first(protocol, 'editedMessage', 'EditedMessage'));
  const messageId = text(first(key, 'ID', 'id'));
  if (!messageId || !edited) return null;

  const mapped = bodyAndType(edited);
  return {
    messageId,
    chatId: toNeutralWhatsAppId(first(info, 'Chat', 'chat') ?? first(key, 'remoteJID', 'remoteJid')),
    body: mapped.body,
    type: mapped.type,
    timestamp: unixSeconds(first(info, 'Timestamp', 'timestamp')),
  };
}

export interface EvolutionHistoryEntry {
  message: IncomingMessage;
  /** Raw waE2E.Message required by Evolution Go's download-media route. */
  rawMessage: unknown;
}

/** Extract messages and their media descriptors from whatsmeow HistorySync protobuf JSON. */
export function mapEvolutionHistorySyncEntries(payload: unknown, selfJid = ''): EvolutionHistoryEntry[] {
  const envelope = record(payload);
  const eventData = record(first(envelope, 'data', 'Data')) ?? envelope;
  const syncData = record(first(eventData, 'Data', 'data')) ?? eventData;
  const conversations = first(syncData, 'Conversations', 'conversations');
  if (!Array.isArray(conversations)) return [];

  const result: EvolutionHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const conversation of conversations) {
    const chat = record(conversation);
    if (!chat) continue;
    const chatId = toNeutralWhatsAppId(first(chat, 'ID', 'id', 'JID', 'jid'));
    const messages = first(chat, 'Messages', 'messages');
    if (!Array.isArray(messages)) continue;
    for (const item of messages) {
      const wrapper = record(item);
      const raw = record(first(wrapper, 'Message', 'message')) ?? wrapper;
      if (!raw) continue;
      const mapped = mapEvolutionMessage(raw, selfJid);
      if (!mapped || seen.has(mapped.id)) continue;
      if (!mapped.chatId && chatId) mapped.chatId = chatId;
      seen.add(mapped.id);
      result.push({ message: mapped, rawMessage: messageContainer(raw) });
    }
  }
  return result.sort((a, b) => a.message.timestamp - b.message.timestamp);
}

/** Backward-compatible message-only history mapper. */
export function mapEvolutionHistorySync(payload: unknown, selfJid = ''): IncomingMessage[] {
  return mapEvolutionHistorySyncEntries(payload, selfJid).map(entry => entry.message);
}
