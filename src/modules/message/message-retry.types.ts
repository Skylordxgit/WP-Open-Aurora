import { createHash } from 'crypto';

export type OutboundRetryPayload =
  | { kind: 'text'; chatId: string; text: string }
  | { kind: 'image' | 'video' | 'audio' | 'document' | 'sticker'; chatId: string; caption?: string }
  | {
      kind: 'location';
      chatId: string;
      latitude: number;
      longitude: number;
      description?: string;
      address?: string;
    }
  | { kind: 'contact'; chatId: string; contactName: string; contactNumber: string }
  | { kind: 'reply'; chatId: string; quotedMessageId: string; text: string };

export function readOutboundRetryPayload(metadata?: Record<string, unknown>): OutboundRetryPayload | null {
  const value = metadata?.retry;
  if (!value || typeof value !== 'object') return null;
  const retry = value as Record<string, unknown>;
  if (typeof retry.kind !== 'string' || typeof retry.chatId !== 'string') return null;
  return retry as unknown as OutboundRetryPayload;
}

/** WhatsApp-safe deterministic ID reused for every attempt of one stored outgoing row. */
export function outboundClientMessageId(messageId: string): string {
  return createHash('sha256').update(messageId).digest('hex').slice(0, 20).toUpperCase();
}
