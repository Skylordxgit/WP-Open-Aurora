import { StorageService } from '../storage/storage.service';
import { MediaArchiveService } from './media-archive.service';

describe('MediaArchiveService', () => {
  it('writes base64 media to a stable per-session object path', async () => {
    const storage = { putFile: jest.fn().mockResolvedValue(undefined), getFile: jest.fn() };
    const service = new MediaArchiveService(storage as unknown as StorageService);

    const archived = await service.archiveMessage('session/one', {
      id: 'wa-message-1',
      from: '1555@c.us',
      to: 'me@c.us',
      chatId: '1555@c.us',
      body: '',
      type: 'image',
      timestamp: 1_704_067_200,
      fromMe: false,
      isGroup: false,
      media: { mimetype: 'image/png', filename: 'photo.png', data: 'aGVsbG8=' },
    });

    expect(storage.putFile).toHaveBeenCalledWith(
      expect.stringMatching(/^whatsapp\/session_one\/2024\/01\/[a-f0-9]{64}\.png$/),
      Buffer.from('hello'),
    );
    expect(archived.media?.storagePath).toMatch(/^whatsapp\/session_one\/2024\/01\//);
  });

  it('does not write the same message again when it already has an Aurora storage key', async () => {
    const storage = { putFile: jest.fn(), getFile: jest.fn() };
    const service = new MediaArchiveService(storage as unknown as StorageService);
    const message = {
      id: 'wa-message-1',
      from: '1555@c.us',
      to: 'me@c.us',
      chatId: '1555@c.us',
      body: '',
      type: 'image' as const,
      timestamp: 1_704_067_200,
      fromMe: false,
      isGroup: false,
      media: { mimetype: 'image/png', storagePath: 'whatsapp/already-stored.png' },
    };

    await expect(service.archiveMessage('session-one', message)).resolves.toBe(message);
    expect(storage.putFile).not.toHaveBeenCalled();
  });
});
