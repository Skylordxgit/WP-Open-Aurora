import type { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { MessageDirection, MessageStatus } from '../message/entities/message.entity';

export interface WorkspaceHistoryMessage {
  id: string;
  waMessageId?: string | null;
  chatId: string;
  from: string;
  to: string;
  body: string;
  type: string;
  direction: MessageDirection;
  status: MessageStatus;
  timestamp?: number | null;
  createdAt: Date | string;
  metadata?: Record<string, unknown> | null;
}

const statusRank: Record<MessageStatus, number> = {
  [MessageStatus.FAILED]: 0,
  [MessageStatus.PENDING]: 1,
  [MessageStatus.SENT]: 2,
  [MessageStatus.DELIVERED]: 3,
  [MessageStatus.READ]: 4,
};

function messageTimestamp(message: WorkspaceHistoryMessage): number {
  const timestamp = Number(message.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;

  const createdAt = new Date(message.createdAt).getTime();
  return Number.isFinite(createdAt) ? Math.floor(createdAt / 1000) : 0;
}

export function normalizeLiveWorkspaceMessage(message: IncomingMessage): WorkspaceHistoryMessage {
  const metadata: Record<string, unknown> = {};
  if (message.media) metadata.media = message.media;
  if (message.quotedMessage) metadata.quotedMessage = message.quotedMessage;
  if (message.location) metadata.location = message.location;
  if (message.author) metadata.author = message.author;
  if (message.senderPhone) metadata.senderPhone = message.senderPhone;
  if (message.contact) metadata.contact = message.contact;

  return {
    id: message.id,
    waMessageId: message.id,
    chatId: message.chatId,
    from: message.from,
    to: message.to,
    body: message.body || '',
    type: message.type,
    direction: message.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
    status: MessageStatus.SENT,
    timestamp: message.timestamp,
    createdAt: new Date(message.timestamp * 1000),
    metadata: Object.keys(metadata).length ? metadata : undefined,
  };
}

export function mergeWorkspaceMessageHistory(
  liveMessages: WorkspaceHistoryMessage[],
  storedMessages: WorkspaceHistoryMessage[],
  limit: number,
): WorkspaceHistoryMessage[] {
  const merged = new Map<string, WorkspaceHistoryMessage>();

  for (const message of [...liveMessages, ...storedMessages]) {
    const key = message.waMessageId || message.id;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, message);
      continue;
    }

    const metadata = { ...existing.metadata, ...message.metadata };
    const status = statusRank[message.status] >= statusRank[existing.status] ? message.status : existing.status;
    merged.set(key, {
      ...existing,
      ...message,
      body: message.body?.trim() ? message.body : existing.body,
      type: message.type === 'unknown' && existing.type !== 'unknown' ? existing.type : message.type,
      status,
      metadata: Object.keys(metadata).length ? metadata : undefined,
    });
  }

  return [...merged.values()].sort((a, b) => messageTimestamp(b) - messageTimestamp(a)).slice(0, limit);
}
