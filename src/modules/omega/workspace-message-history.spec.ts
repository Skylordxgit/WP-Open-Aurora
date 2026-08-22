import { MessageDirection, MessageStatus } from '../message/entities/message.entity';
import {
  mergeWorkspaceMessageHistory,
  normalizeLiveWorkspaceMessage,
  WorkspaceHistoryMessage,
} from './workspace-message-history';

describe('workspace message history', () => {
  it('normalizes live messages for the existing workspace response', () => {
    const message = normalizeLiveWorkspaceMessage({
      id: 'wa-1',
      chatId: '15550001@c.us',
      from: 'me@c.us',
      to: '15550001@c.us',
      body: 'sent from WhatsApp',
      type: 'text',
      timestamp: 200,
      fromMe: true,
      isGroup: false,
    });

    expect(message).toMatchObject({
      id: 'wa-1',
      waMessageId: 'wa-1',
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
    });
  });

  it('deduplicates stored and live copies while retaining delivery state', () => {
    const live = normalizeLiveWorkspaceMessage({
      id: 'wa-1',
      chatId: '15550001@c.us',
      from: '15550001@c.us',
      to: 'me@c.us',
      body: 'hello',
      type: 'text',
      timestamp: 200,
      fromMe: false,
      isGroup: false,
    });
    const stored: WorkspaceHistoryMessage = {
      ...live,
      id: 'db-1',
      status: MessageStatus.READ,
      createdAt: new Date(200_000),
    };

    expect(mergeWorkspaceMessageHistory([live], [stored], 100)).toEqual([
      expect.objectContaining({ id: 'db-1', waMessageId: 'wa-1', body: 'hello', status: MessageStatus.READ }),
    ]);
  });

  it('returns the newest messages in endpoint order and honors the requested limit', () => {
    const makeMessage = (id: string, timestamp: number): WorkspaceHistoryMessage => ({
      id,
      chatId: '15550001@c.us',
      from: '15550001@c.us',
      to: 'me@c.us',
      body: id,
      type: 'text',
      direction: MessageDirection.INCOMING,
      status: MessageStatus.SENT,
      timestamp,
      createdAt: new Date(timestamp * 1000),
    });

    expect(mergeWorkspaceMessageHistory([], [makeMessage('old', 100), makeMessage('new', 300)], 1)).toEqual([
      expect.objectContaining({ id: 'new' }),
    ]);
  });
});
