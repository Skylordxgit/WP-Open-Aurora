import { EvolutionGoAdapter } from './evolution-go.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';

type Listener = (event: any) => void;

class FakeWebSocket {
  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: 'test' });
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  message(payload: Record<string, unknown>): void {
    this.emit('message', {
      data: JSON.stringify({ queue: 'test', payload: JSON.stringify(payload) }),
    });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function pathOf(input: string | URL): string {
  return new URL(input).pathname;
}

function jsonBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== 'string') throw new Error('Expected a JSON string request body');
  return JSON.parse(body) as Record<string, unknown>;
}

describe('EvolutionGoAdapter', () => {
  const createSocketFactory = (): { socket: FakeWebSocket; factory: jest.Mock } => {
    const socket = new FakeWebSocket();
    const factory = jest.fn(() => {
      queueMicrotask(() => socket.open());
      return socket;
    });
    return { socket, factory };
  };

  it('requires stable sidecar credentials instead of silently creating an unsafe fallback', () => {
    expect(
      () =>
        new EvolutionGoAdapter({
          sessionId: 'one',
          baseUrl: 'http://evolution:8080',
          apiKey: '',
          instanceTokenSecret: '',
        }),
    ).toThrow('EVOLUTION_GO_API_KEY');
  });

  it('creates a missing instance, subscribes to all events, and publishes QR updates', async () => {
    const { socket, factory } = createSocketFactory();
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetchImpl = jest.fn((input: string | URL, init?: RequestInit): Promise<Response> => {
      const path = pathOf(input);
      calls.push({ path, init });
      if (path === '/server/ok') return Promise.resolve(jsonResponse({ status: 'ok' }));
      if (path.startsWith('/instance/info/')) return Promise.resolve(jsonResponse({ error: 'record not found' }, 500));
      if (path === '/instance/create') return Promise.resolve(jsonResponse({ data: { token: 'instance-token' } }));
      if (path === '/instance/connect') return Promise.resolve(jsonResponse({ data: { jid: '' } }));
      if (path === '/instance/status')
        return Promise.resolve(jsonResponse({ data: { Connected: false, LoggedIn: false } }));
      if (path === '/instance/qr')
        return Promise.resolve(jsonResponse({ data: { qrcode: 'data:image/png;base64,QR' } }));
      return Promise.reject(new Error(`Unexpected request ${path}`));
    });
    const onQRCode = jest.fn();
    const onDisconnected = jest.fn();
    const adapter = new EvolutionGoAdapter({
      sessionId: 'Sales Team',
      baseUrl: 'http://evolution:8080',
      apiKey: 'global-key',
      instanceTokenSecret: 'stable-secret',
      fetchImpl,
      webSocketFactory: factory,
      healthCheckIntervalMs: 60_000,
    });

    await adapter.initialize({ onQRCode, onDisconnected });

    expect(adapter.getStatus()).toBe(EngineStatus.QR_READY);
    expect(adapter.getQRCode()).toBe('data:image/png;base64,QR');
    expect(onQRCode).toHaveBeenCalledWith('data:image/png;base64,QR');
    expect(factory).toHaveBeenCalledWith(expect.stringContaining('token=global-key'));
    const create = calls.find(call => call.path === '/instance/create');
    const createBody = jsonBody(create?.init?.body);
    expect(createBody).toMatchObject({ name: 'Sales Team' });
    const connect = calls.find(call => call.path === '/instance/connect');
    expect(jsonBody(connect?.init?.body)).toMatchObject({ subscribe: ['ALL'], websocketEnable: 'true' });

    socket.message({
      event: 'QRCode',
      instanceId: createBody.instanceId,
      data: { qrcode: 'data:image/png;base64,NEXT' },
    });
    await Promise.resolve();
    expect(adapter.getQRCode()).toBe('data:image/png;base64,NEXT');

    socket.message({ event: 'QRSuccess', instanceId: createBody.instanceId, data: {} });
    await Promise.resolve();
    expect(adapter.getStatus()).toBe(EngineStatus.AUTHENTICATING);
    socket.message({
      event: 'QRTimeout',
      instanceId: createBody.instanceId,
      data: { reason: 'QR attempts exhausted' },
    });
    await Promise.resolve();
    expect(onDisconnected).toHaveBeenCalledWith('QR attempts exhausted');
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    await adapter.destroy();
    expect(calls.some(call => call.path === '/instance/disconnect')).toBe(false);
  });

  it('reattaches to a ready instance, decodes live/history events, and advances receipts', async () => {
    const { socket, factory } = createSocketFactory();
    let instanceId = '';
    const fetchImpl = jest.fn((input: string | URL, init?: RequestInit): Promise<Response> => {
      const path = pathOf(input);
      if (path === '/server/ok') return Promise.resolve(jsonResponse({ status: 'ok' }));
      if (path.startsWith('/instance/info/')) {
        instanceId = path.split('/').pop()!;
        return Promise.resolve(jsonResponse({ data: { token: 'persisted-token' } }));
      }
      if (path === '/instance/connect')
        return Promise.resolve(jsonResponse({ data: { jid: '15550000000@s.whatsapp.net' } }));
      if (path === '/instance/status')
        return Promise.resolve(jsonResponse({ data: { Connected: true, LoggedIn: true, Name: 'Aurora' } }));
      if (path === '/user/contacts') return Promise.resolve(jsonResponse({ data: [] }));
      if (path === '/message/downloadmedia') {
        expect(jsonBody(init?.body)).toEqual({
          message: { imageMessage: { mimetype: 'image/jpeg', url: 'encrypted-media-descriptor' } },
        });
        return Promise.resolve(jsonResponse({ data: { base64: 'data:image/jpeg;base64,aW1hZ2U=', timestamp: '123' } }));
      }
      if (path === '/chat/history-sync') return Promise.resolve(jsonResponse({ data: { ID: 'SYNC-REQUEST-1' } }));
      if (path === '/send/text') {
        expect(new Headers(init?.headers).get('apikey')).toBe('persisted-token');
        return Promise.resolve(jsonResponse({ data: { Info: { ID: 'SENT-1', Timestamp: '2026-08-22T13:00:00Z' } } }));
      }
      if (path === '/message/edit') {
        expect(jsonBody(init?.body)).toEqual({
          chat: '15551112222@s.whatsapp.net',
          messageId: 'SENT-1',
          message: 'corrected reply',
        });
        return Promise.resolve(jsonResponse({ message: 'success' }));
      }
      return Promise.reject(new Error(`Unexpected request ${path}`));
    });
    const onReady = jest.fn();
    const onMessage = jest.fn();
    const onHistorySync = jest.fn();
    const onMessageAck = jest.fn();
    const onMessageEdited = jest.fn();
    const adapter = new EvolutionGoAdapter({
      sessionId: 'support',
      baseUrl: 'http://evolution:8080',
      apiKey: 'global-key',
      instanceTokenSecret: 'stable-secret',
      fetchImpl,
      webSocketFactory: factory,
      healthCheckIntervalMs: 60_000,
    });

    await adapter.initialize({ onReady, onMessage, onHistorySync, onMessageAck, onMessageEdited });
    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    expect(adapter.getPhoneNumber()).toBe('15550000000');
    expect(onReady).toHaveBeenCalledWith('15550000000', 'Aurora');

    socket.message({
      event: 'Message',
      instanceId,
      data: {
        Info: {
          ID: 'IN-1',
          Chat: '15551112222@s.whatsapp.net',
          Sender: '15551112222@s.whatsapp.net',
          Timestamp: 123,
        },
        Message: { conversation: 'hello' },
      },
    });
    socket.message({ event: 'Receipt', instanceId, state: 'Read', data: { MessageIDs: ['SENT-1'] } });
    socket.message({
      event: 'Message',
      instanceId,
      data: {
        Info: { ID: 'EDIT-EVENT-1', Chat: '15551112222@s.whatsapp.net', Timestamp: 124 },
        Message: {
          protocolMessage: {
            type: 'MESSAGE_EDIT',
            key: { ID: 'SENT-1' },
            editedMessage: { extendedTextMessage: { text: 'corrected reply' } },
          },
        },
      },
    });
    socket.message({
      event: 'HistorySync',
      instanceId,
      data: {
        Data: {
          Conversations: [
            {
              ID: '15551112222@s.whatsapp.net',
              Messages: [
                {
                  Message: {
                    Info: {
                      ID: 'OLD-1',
                      Chat: '15551112222@s.whatsapp.net',
                      Sender: '15551112222@s.whatsapp.net',
                      Timestamp: 100,
                    },
                    Message: { conversation: 'old' },
                  },
                },
                {
                  Message: {
                    Info: {
                      ID: 'OLD-MEDIA-1',
                      Chat: '15551112222@s.whatsapp.net',
                      Sender: '15551112222@s.whatsapp.net',
                      Timestamp: 101,
                    },
                    Message: { imageMessage: { mimetype: 'image/jpeg', url: 'encrypted-media-descriptor' } },
                  },
                },
              ],
            },
          ],
        },
      },
    });
    await Promise.resolve();

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'IN-1', chatId: '15551112222@c.us' }));
    expect(onMessageAck).toHaveBeenCalledWith('SENT-1', 'read');
    expect(onMessageEdited).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'SENT-1', chatId: '15551112222@c.us', body: 'corrected reply' }),
    );
    expect(onHistorySync).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'OLD-1' }),
      expect.objectContaining({ id: 'OLD-MEDIA-1', type: 'image' }),
    ]);
    await expect(adapter.getChats()).resolves.toEqual([
      expect.objectContaining({ id: '15551112222@c.us', lastMessage: 'hello' }),
    ]);
    await expect(adapter.getChatHistory('15551112222@c.us', 10)).resolves.toHaveLength(3);
    const historyWithMedia = await adapter.getChatHistory('15551112222@c.us', 10, true);
    expect(historyWithMedia.find(message => message.id === 'OLD-MEDIA-1')).toMatchObject({
      media: { data: 'data:image/jpeg;base64,aW1hZ2U=' },
    });
    await expect(adapter.sendTextMessage('15551112222@c.us', 'reply')).resolves.toEqual({
      id: 'SENT-1',
      timestamp: 1_787_403_600,
    });
    await expect(adapter.editMessage('15551112222@c.us', 'SENT-1', 'corrected reply')).resolves.toBeUndefined();
    await adapter.destroy();
  });

  it('turns remote client-disconnected send failures into the stable session error', async () => {
    const { factory } = createSocketFactory();
    const fetchImpl = jest.fn((input: string | URL): Promise<Response> => {
      const path = pathOf(input);
      if (path === '/server/ok') return Promise.resolve(jsonResponse({ status: 'ok' }));
      if (path.startsWith('/instance/info/'))
        return Promise.resolve(jsonResponse({ data: { token: 'instance-token' } }));
      if (path === '/instance/connect') return Promise.resolve(jsonResponse({ data: { jid: '1555@s.whatsapp.net' } }));
      if (path === '/instance/status')
        return Promise.resolve(jsonResponse({ data: { Connected: true, LoggedIn: true } }));
      if (path === '/user/contacts') return Promise.resolve(jsonResponse({ data: [] }));
      if (path === '/send/text') return Promise.resolve(jsonResponse({ error: 'client disconnected' }, 500));
      return Promise.reject(new Error(`Unexpected request ${path}`));
    });
    const adapter = new EvolutionGoAdapter({
      sessionId: 'failure',
      baseUrl: 'http://evolution:8080',
      apiKey: 'global-key',
      instanceTokenSecret: 'stable-secret',
      fetchImpl,
      webSocketFactory: factory,
      healthCheckIntervalMs: 60_000,
    });
    await adapter.initialize({});

    await expect(adapter.sendTextMessage('1556@c.us', 'hello')).rejects.toBeInstanceOf(EngineNotReadyError);
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    await adapter.destroy();
  });
});
