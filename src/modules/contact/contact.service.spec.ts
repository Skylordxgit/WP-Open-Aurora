import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ContactService } from './contact.service';
import { SessionService } from '../session/session.service';
import { EngineStatus, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

describe('ContactService', () => {
  const makeService = (engine: Partial<IWhatsAppEngine> | undefined) => {
    const sessionService = { getEngine: jest.fn().mockReturnValue(engine) } as unknown as SessionService;
    const savedContactRepository = {
      find: jest.fn().mockResolvedValue([]),
    };
    const messageRepository = { find: jest.fn().mockResolvedValue([]) };
    return new ContactService(sessionService, savedContactRepository as never, messageRepository as never);
  };

  it('throws 400 when the session is not started', () => {
    expect(() => makeService(undefined).getContacts('s1')).toThrow(BadRequestException);
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

  it('returns 503 while the WhatsApp session is still synchronizing so callers can retry', async () => {
    const svc = makeService({ getStatus: jest.fn().mockReturnValue(EngineStatus.INITIALIZING) });
    await expect(svc.resolveContacts('s1', ['152695264563252@lid'])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
