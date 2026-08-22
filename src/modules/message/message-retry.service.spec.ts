import { Repository } from 'typeorm';
import { MediaArchiveService } from '../../common/media/media-archive.service';
import { EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import { EventsGateway } from '../events/events.gateway';
import { SessionService } from '../session/session.service';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { MessageRetryService } from './message-retry.service';
import { outboundClientMessageId } from './message-retry.types';

function retryMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'local-message-1',
    sessionId: 'session-1',
    waMessageId: null as unknown as string,
    chatId: '15551234567@c.us',
    from: 'me',
    to: '15551234567@c.us',
    body: 'hello',
    type: 'text',
    direction: MessageDirection.OUTGOING,
    timestamp: 1_700_000_000,
    metadata: { retry: { kind: 'text', chatId: '15551234567@c.us', text: 'hello' } },
    mediaPath: null as unknown as string,
    mediaMimetype: null as unknown as string,
    retryCount: 0,
    nextRetryAt: new Date(Date.now() - 1000),
    lastError: 'network unavailable',
    status: MessageStatus.FAILED,
    createdAt: new Date(Date.now() - 60_000),
    ...overrides,
  };
}

describe('MessageRetryService', () => {
  it('claims a due row and retries it with a deterministic Evolution message id', async () => {
    const message = retryMessage();
    const repository = {
      find: jest.fn().mockResolvedValue([message]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn().mockImplementation(value => Promise.resolve(value)),
    };
    const engine = {
      getStatus: jest.fn().mockReturnValue(EngineStatus.READY),
      sendTextMessage: jest.fn().mockResolvedValue({ id: 'wa-message-1', timestamp: 1_700_000_001 }),
    };
    const events = { emitMessageAck: jest.fn() };
    const service = new MessageRetryService(
      repository as unknown as Repository<Message>,
      { getEngine: jest.fn().mockReturnValue(engine) } as unknown as SessionService,
      { read: jest.fn() } as unknown as MediaArchiveService,
      events as unknown as EventsGateway,
    );

    await service.processDueMessages();

    expect(engine.sendTextMessage).toHaveBeenCalledWith(
      '15551234567@c.us',
      'hello',
      outboundClientMessageId(message.id),
    );
    expect(message.status).toBe(MessageStatus.SENT);
    expect(message.waMessageId).toBe('wa-message-1');
    expect(message.nextRetryAt).toBeNull();
    expect(message.metadata.retry).toBeUndefined();
    expect(events.emitMessageAck).toHaveBeenCalledWith('session-1', {
      messageId: 'wa-message-1',
      status: 'sent',
    });
  });

  it('reschedules without consuming an attempt while the session is disconnected', async () => {
    const message = retryMessage();
    const repository = {
      find: jest.fn().mockResolvedValue([message]),
      update: jest.fn(),
      save: jest.fn().mockImplementation(value => Promise.resolve(value)),
    };
    const engine = { getStatus: jest.fn().mockReturnValue(EngineStatus.DISCONNECTED), sendTextMessage: jest.fn() };
    const service = new MessageRetryService(
      repository as unknown as Repository<Message>,
      { getEngine: jest.fn().mockReturnValue(engine) } as unknown as SessionService,
      { read: jest.fn() } as unknown as MediaArchiveService,
      { emitMessageAck: jest.fn() } as unknown as EventsGateway,
    );

    await service.processDueMessages();

    expect(engine.sendTextMessage).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    expect(message.retryCount).toBe(0);
    expect(message.nextRetryAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it('stops retrying a permanent recipient failure', async () => {
    const message = retryMessage();
    const repository = {
      find: jest.fn().mockResolvedValue([message]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn().mockImplementation(value => Promise.resolve(value)),
    };
    const engine = {
      getStatus: jest.fn().mockReturnValue(EngineStatus.READY),
      sendTextMessage: jest.fn().mockRejectedValue(new Error('number is not registered in WhatsApp')),
    };
    const service = new MessageRetryService(
      repository as unknown as Repository<Message>,
      { getEngine: jest.fn().mockReturnValue(engine) } as unknown as SessionService,
      { read: jest.fn() } as unknown as MediaArchiveService,
      { emitMessageAck: jest.fn() } as unknown as EventsGateway,
    );

    await service.processDueMessages();

    expect(message.status).toBe(MessageStatus.FAILED);
    expect(message.retryCount).toBe(1);
    expect(message.nextRetryAt).toBeNull();
  });
});
