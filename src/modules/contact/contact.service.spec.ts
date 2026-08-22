import { NotFoundException } from '@nestjs/common';
import { ContactService } from './contact.service';
import { SessionService } from '../session/session.service';
import { EngineStatus, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

describe('ContactService', () => {
  const makeService = (
    engine: Partial<IWhatsAppEngine> | undefined,
    options?: { snapshot?: Record<string, unknown>; archivedProfile?: Buffer },
  ) => {
    const normalizedEngine = engine
      ? ({ getStatus: jest.fn().mockReturnValue(EngineStatus.READY), ...engine } as Partial<IWhatsAppEngine>)
      : undefined;
    const sessionService = { getEngine: jest.fn().mockReturnValue(normalizedEngine) } as unknown as SessionService;
    const savedContactRepository = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((value: Record<string, unknown>): Record<string, unknown> => value),
      save: jest.fn((value: unknown): Promise<unknown> => Promise.resolve(value)),
    };
    const messageRepository = { find: jest.fn().mockResolvedValue([]) };
    const chatSnapshotRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(options?.snapshot ?? null),
      create: jest.fn((value: Record<string, unknown>): Record<string, unknown> => value),
      save: jest.fn((value: unknown): Promise<unknown> => Promise.resolve(value)),
    };
    const mediaArchiveService = {
      archiveMedia: jest.fn().mockResolvedValue({ storagePath: 'profiles/contact.jpg', mimetype: 'image/jpeg' }),
      read: jest.fn().mockResolvedValue(options?.archivedProfile ?? Buffer.from('profile')),
    };
    return new ContactService(
      sessionService,
      savedContactRepository as never,
      messageRepository as never,
      chatSnapshotRepository as never,
      mediaArchiveService as never,
    );
  };

  it('returns stored contacts without requiring a started session', async () => {
    await expect(makeService(undefined).getContacts('s1')).resolves.toEqual([]);
  });

  it('maps a missing contact to 404', async () => {
    const svc = makeService({ getContactById: jest.fn().mockResolvedValue(null) });
    await expect(svc.getContactById('s1', 'c404')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('delegates checkNumberExists to the engine', async () => {
    const checkNumberExists = jest.fn().mockResolvedValue(true);
    await expect(makeService({ checkNumberExists }).checkNumberExists('s1', '628123')).resolves.toBe(true);
    expect(checkNumberExists).toHaveBeenCalledWith('628123');
  });

  it('delegates getNumberId to the engine (canonical JID resolution)', async () => {
    const getNumberId = jest.fn().mockResolvedValue('628123@c.us');
    await expect(makeService({ getNumberId }).getNumberId('s1', '628123')).resolves.toBe('628123@c.us');
    expect(getNumberId).toHaveBeenCalledWith('628123');
  });

  it('archives a live profile picture without changing the response contract', async () => {
    const getProfilePicture = jest.fn().mockResolvedValue('https://pps.whatsapp.net/profile.jpg');
    await expect(makeService({ getProfilePicture }).getProfilePicture('s1', '628123@c.us')).resolves.toBe(
      'https://pps.whatsapp.net/profile.jpg',
    );
  });

  it('serves an archived profile picture while the session is offline', async () => {
    const snapshot = {
      sessionId: 's1',
      chatId: '628123@c.us',
      profilePicPath: 'profiles/contact.jpg',
      profilePicMimetype: 'image/jpeg',
    };
    await expect(
      makeService(undefined, { snapshot, archivedProfile: Buffer.from('profile') }).getProfilePicture(
        's1',
        '628123@c.us',
      ),
    ).resolves.toBe(`data:image/jpeg;base64,${Buffer.from('profile').toString('base64')}`);
  });

  it('delegates resolveContactPhone to the engine', async () => {
    const resolveContactPhone = jest.fn().mockResolvedValue('628123456789');
    await expect(makeService({ resolveContactPhone }).resolveContactPhone('s1', '123@lid')).resolves.toBe(
      '628123456789',
    );
    expect(resolveContactPhone).toHaveBeenCalledWith('123@lid');
  });

  it('keeps the HTTP contract null-safe when the engine lookup fails transiently', async () => {
    const resolveContactPhone = jest.fn().mockRejectedValue(new Error('Evaluation failed'));
    await expect(makeService({ resolveContactPhone }).resolveContactPhone('s1', '123@lid')).resolves.toBeNull();
  });

  it('resolves privacy IDs to a contact name and actual phone number', async () => {
    const svc = makeService({
      getStatus: jest.fn().mockReturnValue(EngineStatus.READY),
      getContacts: jest.fn().mockResolvedValue([
        {
          id: '628123456789@c.us',
          number: '628123456789',
          name: 'Alice',
          isMyContact: true,
          isBlocked: false,
        },
      ]),
      resolveContactPhone: jest.fn().mockResolvedValue('628123456789'),
    });

    await expect(svc.resolveContacts('s1', ['152695264563252@lid'])).resolves.toEqual([
      { contactId: '152695264563252@lid', phone: '628123456789', name: 'Alice' },
    ]);
  });

  it('uses a direct contact number only when it differs from the privacy identifier', async () => {
    const svc = makeService({
      getStatus: jest.fn().mockReturnValue(EngineStatus.READY),
      getContacts: jest.fn().mockResolvedValue([
        {
          id: '152695264563252@lid',
          number: '628123456789',
          name: 'Alice',
          isMyContact: true,
          isBlocked: false,
        },
      ]),
      resolveContactPhone: jest.fn().mockResolvedValue(null),
    });

    await expect(svc.resolveContacts('s1', ['152695264563252@lid'])).resolves.toEqual([
      { contactId: '152695264563252@lid', phone: '628123456789', name: 'Alice' },
    ]);
  });

  it('rejects a direct contact number that is only the LID token', async () => {
    const svc = makeService({
      getStatus: jest.fn().mockReturnValue(EngineStatus.READY),
      getContacts: jest.fn().mockResolvedValue([
        {
          id: '152695264563252@lid',
          number: '152695264563252',
          isMyContact: false,
          isBlocked: false,
        },
      ]),
      resolveContactPhone: jest.fn().mockResolvedValue(null),
    });

    await expect(svc.resolveContacts('s1', ['152695264563252@lid'])).resolves.toEqual([
      { contactId: '152695264563252@lid', phone: null, name: null },
    ]);
  });

  it('returns persisted identity data while the WhatsApp session is synchronizing', async () => {
    const svc = makeService({ getStatus: jest.fn().mockReturnValue(EngineStatus.INITIALIZING) });
    await expect(svc.resolveContacts('s1', ['152695264563252@lid'])).resolves.toEqual([
      { contactId: '152695264563252@lid', phone: null, name: null },
    ]);
  });
});
