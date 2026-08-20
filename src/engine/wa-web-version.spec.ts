import {
  __resetWebVersionCache,
  pickSettledWebVersion,
  resolveCurrentWebVersion,
  resolveWebVersionPin,
  WEB_VERSION_SETTLE_MS,
} from './wa-web-version';

describe('WhatsApp Web version selection', () => {
  const originalVersion = process.env.WWEBJS_WEB_VERSION;
  const originalRemote = process.env.WWEBJS_WEB_VERSION_REMOTE_PATH;

  beforeEach(() => {
    __resetWebVersionCache();
    delete process.env.WWEBJS_WEB_VERSION;
    delete process.env.WWEBJS_WEB_VERSION_REMOTE_PATH;
  });

  afterAll(() => {
    if (originalVersion === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = originalVersion;
    if (originalRemote === undefined) delete process.env.WWEBJS_WEB_VERSION_REMOTE_PATH;
    else process.env.WWEBJS_WEB_VERSION_REMOTE_PATH = originalRemote;
  });

  it('chooses the newest settled, stable, unexpired registry build', () => {
    const now = Date.parse('2026-08-20T12:00:00Z');
    const versions = [
      { version: '2.1.0', released: new Date(now - WEB_VERSION_SETTLE_MS - 2000).toISOString() },
      { version: '2.2.0', released: new Date(now - WEB_VERSION_SETTLE_MS - 1000).toISOString() },
      { version: '2.3.0', released: new Date(now - 1000).toISOString() },
      { version: '2.4.0', beta: true, released: new Date(now - WEB_VERSION_SETTLE_MS - 500).toISOString() },
      {
        version: '2.5.0',
        released: new Date(now - WEB_VERSION_SETTLE_MS - 500).toISOString(),
        expire: new Date(now - 1).toISOString(),
      },
    ];

    expect(pickSettledWebVersion(versions, now, '2.0.0')).toBe('2.2.0');
  });

  it('keeps an explicit engine build and supports a custom remote template', async () => {
    process.env.WWEBJS_WEB_VERSION = '2.3000.123';
    process.env.WWEBJS_WEB_VERSION_REMOTE_PATH = 'https://versions.example/{version}.html';
    const fetcher = jest.fn() as unknown as typeof fetch;

    await expect(resolveWebVersionPin(fetcher)).resolves.toEqual({
      webVersion: '2.3000.123',
      webVersionCache: { type: 'remote', remotePath: 'https://versions.example/2.3000.123.html' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses native selection only when explicitly disabled', async () => {
    process.env.WWEBJS_WEB_VERSION = 'off';
    const fetcher = jest.fn() as unknown as typeof fetch;

    await expect(resolveWebVersionPin(fetcher)).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('caches a successful registry resolution', async () => {
    const released = new Date(Date.now() - WEB_VERSION_SETTLE_MS - 1000).toISOString();
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ currentVersion: '2.3000.200', versions: [{ version: '2.3000.199', released }] }),
    }) as unknown as typeof fetch;

    await expect(resolveCurrentWebVersion(fetcher)).resolves.toBe('2.3000.199');
    await expect(resolveCurrentWebVersion(fetcher)).resolves.toBe('2.3000.199');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('falls back without pinning when the registry is unavailable', async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;

    await expect(resolveWebVersionPin(fetcher)).resolves.toBeUndefined();
    await expect(resolveWebVersionPin(fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
