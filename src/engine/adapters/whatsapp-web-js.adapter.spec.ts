import { EventEmitter } from 'events';
import { MessageMedia, WAState } from 'whatsapp-web.js';
import {
  WhatsAppWebJsAdapter,
  READY_RECONCILE_BRIDGE_RELOAD_GRACE_MS,
  READY_RECONCILE_TIMEOUT_MS,
  extractLinkedParentJID,
  isNoLidForUserError,
  loadRemoteMedia,
  resolveWebVersionPin,
  wwebjsAckToDeliveryStatus,
} from './whatsapp-web-js.adapter';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { RecipientUnreachableError } from '../../common/errors/recipient-unreachable.error';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { SsrfBlockedError } from '../../common/security/ssrf-guard';
import { __resetWebVersionCache, WEB_VERSION_SETTLE_MS } from '../wa-web-version';

describe('wwebjsAckToDeliveryStatus (engine ack-int -> neutral DeliveryStatus boundary, #265)', () => {
  // Regression-locks the integer boundary the decoupling moved behaviour into, incl. the
  // PLAYED(4) -> 'read' collapse that the old ackToMessageStatus(4) -> READ test used to cover.
  it.each([
    [-1, 'failed'],
    [0, 'pending'],
    [1, 'sent'],
    [2, 'delivered'],
    [3, 'read'],
    [4, 'read'], // PLAYED collapses to read
    [5, 'read'], // any future/higher ack stays read, never crashes
  ])('maps wwebjs ack %i -> %s', (ack, expected) => {
    expect(wwebjsAckToDeliveryStatus(ack)).toBe(expected);
  });
});

describe('extractLinkedParentJID (#201)', () => {
  it('returns null when no metadata is provided', () => {
    expect(extractLinkedParentJID()).toBeNull();
    expect(extractLinkedParentJID({})).toBeNull();
  });

  it('reads a string candidate directly', () => {
    expect(extractLinkedParentJID({ parentGroup: '120363000@g.us' })).toBe('120363000@g.us');
  });

  it('reads the _serialized field of a Wid candidate', () => {
    expect(extractLinkedParentJID({ parentGroup: { _serialized: '120363111@g.us' } })).toBe('120363111@g.us');
  });

  it('returns null when a Wid candidate has no _serialized', () => {
    expect(extractLinkedParentJID({ parentGroup: {} })).toBeNull();
  });

  it('prefers parentGroup, then linkedParentGroup, then linkedParent', () => {
    expect(
      extractLinkedParentJID({
        parentGroup: 'a@g.us',
        linkedParentGroup: 'b@g.us',
        linkedParent: 'c@g.us',
      }),
    ).toBe('a@g.us');

    expect(extractLinkedParentJID({ linkedParentGroup: 'b@g.us', linkedParent: 'c@g.us' })).toBe('b@g.us');
    expect(extractLinkedParentJID({ linkedParent: 'c@g.us' })).toBe('c@g.us');
  });

  it('ignores null/undefined candidates and falls through to the next', () => {
    expect(extractLinkedParentJID({ parentGroup: null, linkedParentGroup: 'b@g.us' })).toBe('b@g.us');
  });
});

describe('loadRemoteMedia — media-fetch SSRF guard + cap + timeout', () => {
  let fromUrlSpy: jest.SpyInstance;

  beforeEach(() => {
    fromUrlSpy = jest
      .spyOn(MessageMedia, 'fromUrl')
      .mockResolvedValue(new MessageMedia('image/png', 'ZmFrZQ==', 'x.png'));
  });

  afterEach(() => {
    fromUrlSpy.mockRestore();
    delete process.env.SSRF_ALLOWED_HOSTS;
  });

  it('blocks an internal/loopback URL BEFORE any fetch (no outbound socket)', async () => {
    await expect(loadRemoteMedia('http://127.0.0.1/x.png')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fromUrlSpy).not.toHaveBeenCalled();
  });

  it('blocks the cloud-metadata IP before fetching', async () => {
    await expect(loadRemoteMedia('http://169.254.169.254/latest/meta-data/x.png')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(fromUrlSpy).not.toHaveBeenCalled();
  });

  it('fetches a public URL with a byte cap and an abort-timeout signal', async () => {
    await loadRemoteMedia('https://8.8.8.8/x.png');

    expect(fromUrlSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fromUrlSpy.mock.calls[0] as [
      string,
      { reqOptions: { size: number; signal: unknown; redirect: string } },
    ];
    expect(url).toBe('https://8.8.8.8/x.png');
    expect(typeof options.reqOptions.size).toBe('number');
    expect(options.reqOptions.size).toBeGreaterThan(0);
    expect(options.reqOptions.signal).toBeInstanceOf(AbortSignal);
    expect(options.reqOptions.redirect).toBe('error'); // never follow redirects
  });

  it('honors the SSRF_ALLOWED_HOSTS escape-hatch for trusted internal media stores', async () => {
    process.env.SSRF_ALLOWED_HOSTS = 'minio';
    await loadRemoteMedia('http://minio:9000/bucket/x.png');
    expect(fromUrlSpy).toHaveBeenCalledTimes(1);
  });
});

describe('WhatsAppWebJsAdapter readiness guard (#100)', () => {
  const newAdapter = (): WhatsAppWebJsAdapter =>
    new WhatsAppWebJsAdapter({ sessionId: 'sess-1', sessionDataPath: './data/sessions', puppeteer: {} });

  it('rejects engine read ops with EngineNotReadyError when not connected', async () => {
    const adapter = newAdapter(); // status defaults to DISCONNECTED, no client

    await expect(adapter.getGroups()).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.checkNumberExists('628123')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.getNumberId('628123')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.resolveContactPhone('123@lid')).rejects.toBeInstanceOf(EngineNotReadyError);
  });

  it('carries HTTP 409 so NestJS returns "session not connected" (not 500) without a custom filter', () => {
    expect(new EngineNotReadyError().getStatus()).toBe(409);
  });
});

describe('WhatsAppWebJsAdapter.resolveContactPhone (@lid -> phone, #263)', () => {
  // Stub a "ready" adapter with a fake client so we exercise the mapping without a real browser.
  const readyAdapter = (getContactLidAndPhone: jest.Mock): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = { getContactLidAndPhone };
    return adapter;
  };

  it('returns the phone JID stripped to MSISDN digits', async () => {
    const adapter = readyAdapter(jest.fn().mockResolvedValue([{ lid: '123@lid', pn: '628123456789@c.us' }]));
    await expect(adapter.resolveContactPhone('123@lid')).resolves.toBe('628123456789');
  });

  it('returns null when the engine has no mapping (empty result or empty pn)', async () => {
    await expect(readyAdapter(jest.fn().mockResolvedValue([])).resolveContactPhone('123@lid')).resolves.toBeNull();
    await expect(
      readyAdapter(jest.fn().mockResolvedValue([{ lid: '123@lid', pn: '' }])).resolveContactPhone('123@lid'),
    ).resolves.toBeNull();
  });

  it('falls back to a phone number already hydrated on the WhatsApp contact', async () => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = {
      getContactLidAndPhone: jest.fn().mockResolvedValue([]),
      getContactById: jest.fn().mockResolvedValue({ number: '628555666777' }),
    };

    await expect(adapter.resolveContactPhone('123@lid')).resolves.toBe('628555666777');
  });

  it('falls back to WhatsApp Web alternate-WID runtime data when contact lookup is empty', async () => {
    const evaluate = jest.fn().mockResolvedValue('628999888777@c.us');
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = {
      getContactLidAndPhone: jest.fn().mockResolvedValue([]),
      getContactById: jest.fn().mockResolvedValue({ number: '123' }),
      pupPage: { evaluate },
    };

    await expect(adapter.resolveContactPhone('123@lid')).resolves.toBe('628999888777');
    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), '123@lid');
  });

  it('propagates a transient engine failure so callers do not cache it as a missing mapping', async () => {
    const adapter = readyAdapter(jest.fn().mockRejectedValue(new Error('Evaluation failed')));
    await expect(adapter.resolveContactPhone('123@lid')).rejects.toThrow('Evaluation failed');
  });

  it('reuses a verified mapping when a later page lookup would fail', async () => {
    const getContactLidAndPhone = jest
      .fn()
      .mockResolvedValueOnce([{ lid: '123@lid', pn: '628123456789@c.us' }])
      .mockRejectedValueOnce(new Error('Evaluation failed'));
    const adapter = readyAdapter(getContactLidAndPhone);

    await expect(adapter.resolveContactPhone('123@lid')).resolves.toBe('628123456789');
    await expect(adapter.resolveContactPhone('123@lid')).resolves.toBe('628123456789');
    expect(getContactLidAndPhone).toHaveBeenCalledTimes(1);
  });
});

describe('WhatsAppWebJsAdapter LID send recovery', () => {
  const readyAdapter = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };
  const sentMessage = { id: { _serialized: 'OUT1' }, timestamp: 1700000001 };

  it('recognizes the unstructured whatsapp-web.js LID migration error', () => {
    expect(isNoLidForUserError(new Error('Evaluation failed: No LID for user'))).toBe(true);
    expect(isNoLidForUserError(new Error('network closed'))).toBe(false);
  });

  it('resolves a phone recipient to its current LID before sending', async () => {
    const getNumberId = jest.fn().mockResolvedValue({ _serialized: '159442138038327@lid' });
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    const adapter = readyAdapter({ getNumberId, sendMessage });

    await expect(adapter.sendTextMessage('529934031058@c.us', 'hi')).resolves.toEqual({
      id: 'OUT1',
      timestamp: 1700000001,
    });
    expect(sendMessage).toHaveBeenCalledWith('159442138038327@lid', 'hi');
  });

  it('hydrates and retries an unresolved LID through its verified phone mapping', async () => {
    const sendMessage = jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(sentMessage);
    const getContactLidAndPhone = jest
      .fn()
      .mockResolvedValue([{ lid: '159442138038327@lid', pn: '529934031058@c.us' }]);
    const getNumberId = jest.fn().mockResolvedValue({ _serialized: '159442138038327@lid' });
    const adapter = readyAdapter({ sendMessage, getContactLidAndPhone, getNumberId });

    await expect(adapter.sendTextMessage('159442138038327@lid', 'hi')).resolves.toEqual({
      id: 'OUT1',
      timestamp: 1700000001,
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(getContactLidAndPhone).toHaveBeenCalledWith(['159442138038327@lid']);
    expect(getNumberId).toHaveBeenCalledWith('529934031058');
  });

  it('returns a client-safe unreachable error only after verified recovery is unavailable', async () => {
    const adapter = readyAdapter({
      sendMessage: jest.fn().mockResolvedValue(undefined),
      getContactLidAndPhone: jest.fn().mockResolvedValue([]),
    });

    await expect(adapter.sendTextMessage('159442138038327@lid', 'hi')).rejects.toBeInstanceOf(
      RecipientUnreachableError,
    );
  });
});

describe('resolveWebVersionPin (settled WA-Web version pin)', () => {
  const orig = { v: process.env.WWEBJS_WEB_VERSION, p: process.env.WWEBJS_WEB_VERSION_REMOTE_PATH };
  beforeEach(() => __resetWebVersionCache());
  afterEach(() => {
    if (orig.v === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = orig.v;
    if (orig.p === undefined) delete process.env.WWEBJS_WEB_VERSION_REMOTE_PATH;
    else process.env.WWEBJS_WEB_VERSION_REMOTE_PATH = orig.p;
  });

  it('pins a settled registry version when unset', async () => {
    delete process.env.WWEBJS_WEB_VERSION;
    const released = new Date(Date.now() - WEB_VERSION_SETTLE_MS - 1000).toISOString();
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ currentVersion: '2.3000.200', versions: [{ version: '2.3000.199', released }] }),
    }) as unknown as typeof fetch;

    await expect(resolveWebVersionPin(fetcher)).resolves.toEqual({
      webVersion: '2.3000.199',
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.199.html',
      },
    });
  });

  it('returns undefined only when native selection is explicitly requested', async () => {
    process.env.WWEBJS_WEB_VERSION = 'off';
    const fetcher = jest.fn() as unknown as typeof fetch;
    await expect(resolveWebVersionPin(fetcher)).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('pins a remote webVersionCache from an exact version without a registry request', async () => {
    delete process.env.WWEBJS_WEB_VERSION_REMOTE_PATH;
    process.env.WWEBJS_WEB_VERSION = '2.3000.1023204257';
    const fetcher = jest.fn() as unknown as typeof fetch;
    await expect(resolveWebVersionPin(fetcher)).resolves.toEqual({
      webVersion: '2.3000.1023204257',
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1023204257.html',
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('honors a custom WWEBJS_WEB_VERSION_REMOTE_PATH template ({version} placeholder)', async () => {
    process.env.WWEBJS_WEB_VERSION = '2.9999.0';
    process.env.WWEBJS_WEB_VERSION_REMOTE_PATH = 'https://cdn.example.com/wa/{version}.html';
    await expect(resolveWebVersionPin()).resolves.toMatchObject({
      webVersionCache: { remotePath: 'https://cdn.example.com/wa/2.9999.0.html' },
    });
  });
});

describe('WhatsAppWebJsAdapter ready synchronization', () => {
  type FakeClient = EventEmitter & {
    info: { wid: { user: string }; pushname: string };
    eventsAttached?: boolean;
    getState: jest.Mock;
    pupPage: { evaluate: jest.Mock; reload: jest.Mock };
  };

  function harness(eventsAttached?: boolean) {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sync-session',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { user: '628123' }, pushname: 'Operator' },
      eventsAttached,
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: {
        evaluate: jest.fn().mockResolvedValue(true),
        reload: jest.fn().mockResolvedValue(undefined),
      },
    }) as FakeClient;
    const onReady = jest.fn();
    const onError = jest.fn();
    const internals = adapter as unknown as {
      client: FakeClient;
      callbacks: { onReady: jest.Mock; onError: jest.Mock };
      setupEventHandlers(): void;
      status: EngineStatus;
    };
    internals.client = client;
    internals.callbacks = { onReady, onError };
    internals.setupEventHandlers();
    return { adapter, client, onReady, onError, internals };
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('recovers when whatsapp-web.js misses ready after authentication', async () => {
    const { client, onReady, internals } = harness(true);
    client.emit('authenticated');

    await jest.advanceTimersByTimeAsync(2100);

    expect(internals.status).toBe(EngineStatus.READY);
    expect(onReady).toHaveBeenCalledWith('628123', 'Operator');
  });

  it('does not expose chats or contacts before the message bridge is attached', () => {
    const { client, onReady, internals } = harness(false);
    client.emit('authenticated');
    client.emit('ready');

    expect(internals.status).toBe(EngineStatus.AUTHENTICATING);
    expect(onReady).not.toHaveBeenCalled();

    client.eventsAttached = true;
    client.emit('ready');
    expect(internals.status).toBe(EngineStatus.READY);
  });

  it('reloads a connected page once when the event bridge remains detached', async () => {
    const { client } = harness(false);
    client.emit('authenticated');

    await jest.advanceTimersByTimeAsync(READY_RECONCILE_BRIDGE_RELOAD_GRACE_MS + 2100);

    expect(client.pupPage.reload).toHaveBeenCalledTimes(1);
    client.eventsAttached = true;
    client.emit('ready');
  });

  it('fails clearly instead of waiting forever when synchronization cannot recover', async () => {
    const { client, onError, internals } = harness(false);
    client.emit('authenticated');

    await jest.advanceTimersByTimeAsync(READY_RECONCILE_TIMEOUT_MS + 2100);

    expect(internals.status).toBe(EngineStatus.FAILED);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('message bridge did not attach'));
  });
});
