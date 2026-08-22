import { createHash, createHmac } from 'crypto';
import {
  Catalog,
  Channel,
  ChannelMessage,
  ChatState,
  ChatSummary,
  Contact,
  ContactCard,
  EngineEventCallbacks,
  EngineStatus,
  Group,
  GroupInfo,
  IWhatsAppEngine,
  IncomingMessage,
  Label,
  LocationInput,
  MediaInput,
  MessageReaction,
  MessageResult,
  PaginatedProducts,
  Product,
  Status,
  StatusResult,
  TextStatusOptions,
} from '../interfaces/whatsapp-engine.interface';
import {
  mapEvolutionEdit,
  mapEvolutionHistorySyncEntries,
  mapEvolutionMessage,
  mapEvolutionReaction,
  mapEvolutionReceipt,
  mapEvolutionRevocation,
  toEvolutionWhatsAppId,
  toNeutralWhatsAppId,
} from './evolution-go-message-mapper';
import { EngineNotReadyError, WHATSAPP_SESSION_DISCONNECTED_MESSAGE } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { createLogger } from '../../common/services/logger.service';

type JsonRecord = Record<string, unknown>;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface EvolutionWebSocket {
  readonly readyState: number;
  addEventListener(type: 'open', listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { code?: number; reason?: string }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  close(code?: number, reason?: string): void;
}

export interface EvolutionGoAdapterConfig {
  sessionId: string;
  baseUrl: string;
  apiKey: string;
  instanceTokenSecret: string;
  requestTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  websocketReconnectBaseDelayMs?: number;
  proxyUrl?: string;
  proxyType?: 'http' | 'https' | 'socks4' | 'socks5';
  fetchImpl?: FetchLike;
  webSocketFactory?: (url: string) => EvolutionWebSocket;
}

interface EvolutionApiErrorOptions {
  status: number;
  path: string;
  body: unknown;
}

export class EvolutionGoApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: unknown;

  constructor(options: EvolutionApiErrorOptions) {
    const detail = extractErrorMessage(options.body) || `HTTP ${options.status}`;
    super(`Evolution Go ${options.path}: ${detail}`);
    this.name = 'EvolutionGoApiError';
    this.status = options.status;
    this.path = options.path;
    this.body = options.body;
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function get(value: JsonRecord | undefined, ...keys: string[]): unknown {
  if (!value) return undefined;
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key];
  }
  return undefined;
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1;
}

function numberValue(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function unwrapData(value: unknown): unknown {
  const envelope = asRecord(value);
  return get(envelope, 'data', 'Data') ?? value;
}

function extractErrorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  const data = asRecord(value);
  return stringValue(get(data, 'error', 'message', 'detail'));
}

/**
 * Evolution Go is a licensed, standalone whatsmeow service. This adapter deliberately treats it as
 * a sidecar through Aurora's existing engine boundary: the dashboard and application services never
 * depend on Evolution-specific routes, JIDs, event casing, or lifecycle details.
 */
export class EvolutionGoAdapter implements IWhatsAppEngine {
  private static readonly WS_OPEN = 1;
  private static readonly MAX_CACHE_MESSAGES_PER_CHAT = 2_000;
  private static readonly MAX_RAW_MEDIA_DESCRIPTORS = 10_000;
  private static readonly CONTACT_SYNC_DEBOUNCE_MS = 750;

  private readonly logger = createLogger('EvolutionGoAdapter');
  private readonly baseUrl: URL;
  private readonly fetchImpl: FetchLike;
  private readonly webSocketFactory: (url: string) => EvolutionWebSocket;
  private readonly instanceId: string;
  private readonly requestTimeoutMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly websocketReconnectBaseDelayMs: number;

  private instanceToken: string;
  private callbacks: EngineEventCallbacks = {};
  private status = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private selfJid = '';
  private socket: EvolutionWebSocket | null = null;
  private intentionalClose = false;
  private initialized = false;
  private readyNotified = false;
  private websocketReconnectAttempts = 0;
  private consecutiveHealthFailures = 0;
  private healthTimer?: ReturnType<typeof setInterval>;
  private qrTimer?: ReturnType<typeof setInterval>;
  private websocketReconnectTimer?: ReturnType<typeof setTimeout>;
  private contactSyncTimer?: ReturnType<typeof setTimeout>;

  private readonly chatCache = new Map<string, ChatSummary>();
  private readonly messageCache = new Map<string, IncomingMessage[]>();
  private readonly rawMessages = new Map<string, JsonRecord>();
  private readonly lidPhoneMappings = new Map<string, string>();
  private readonly reactions = new Map<string, Map<string, string>>();
  private readonly historyBackfillRequests = new Map<string, number>();

  constructor(private readonly config: EvolutionGoAdapterConfig) {
    if (!config.baseUrl) throw new Error('EVOLUTION_GO_BASE_URL is required when ENGINE_TYPE=evolution-go');
    if (!config.apiKey) throw new Error('EVOLUTION_GO_API_KEY is required when ENGINE_TYPE=evolution-go');
    if (!config.instanceTokenSecret) {
      throw new Error('EVOLUTION_GO_INSTANCE_TOKEN_SECRET is required when ENGINE_TYPE=evolution-go');
    }

    this.baseUrl = new URL(config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.webSocketFactory = config.webSocketFactory ?? this.defaultWebSocketFactory;
    this.instanceId = this.deriveInstanceId(config.sessionId);
    this.instanceToken = createHmac('sha256', config.instanceTokenSecret).update(this.instanceId).digest('hex');
    this.requestTimeoutMs = Math.max(config.requestTimeoutMs ?? 15_000, 1_000);
    this.healthCheckIntervalMs = Math.max(config.healthCheckIntervalMs ?? 15_000, 5_000);
    this.websocketReconnectBaseDelayMs = Math.max(config.websocketReconnectBaseDelayMs ?? 1_000, 250);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.intentionalClose = false;
    this.initialized = true;
    this.readyNotified = false;
    this.setStatus(EngineStatus.INITIALIZING);

    try {
      await this.assertServiceAvailable();
      await this.ensureRemoteInstance();
      await this.openWebSocket();
      await this.connectRemoteInstance();
      await this.refreshRemoteStatus();
      this.startHealthMonitor();
      if (this.status !== EngineStatus.READY) {
        await this.refreshQRCode();
        this.startQRCodePoll();
      }
    } catch (error) {
      this.setStatus(EngineStatus.FAILED);
      const reason = this.errorMessage(error);
      this.callbacks.onError?.(reason);
      await this.closeLocalResources(false);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    try {
      await this.request('/instance/disconnect', { method: 'POST' }, 'instance');
    } catch (error) {
      if (!this.isAlreadyDisconnectedError(error)) throw error;
    } finally {
      await this.closeLocalResources(true);
    }
  }

  async logout(): Promise<void> {
    this.intentionalClose = true;
    try {
      await this.request('/instance/logout', { method: 'DELETE' }, 'instance');
    } catch (error) {
      if (!this.isAlreadyDisconnectedError(error)) throw error;
    } finally {
      this.qrCode = null;
      this.phoneNumber = null;
      this.pushName = null;
      this.selfJid = '';
      await this.closeLocalResources(true);
    }
  }

  /**
   * Process-local teardown only. Evolution Go owns the durable whatsmeow connection, so an Aurora
   * restart must not log out or stop the remote instance. A new adapter reattaches on startup.
   */
  async destroy(): Promise<void> {
    this.intentionalClose = true;
    await this.closeLocalResources(true);
  }

  private closeLocalResources(updateStatus: boolean): Promise<void> {
    this.initialized = false;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, 'AuroraWA adapter stopped');
      } catch {
        // The remote side may already have closed the socket.
      }
    }
    if (updateStatus) this.setStatus(EngineStatus.DISCONNECTED);
    return Promise.resolve();
  }

  private clearTimers(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.qrTimer) clearInterval(this.qrTimer);
    if (this.websocketReconnectTimer) clearTimeout(this.websocketReconnectTimer);
    if (this.contactSyncTimer) clearTimeout(this.contactSyncTimer);
    this.healthTimer = undefined;
    this.qrTimer = undefined;
    this.websocketReconnectTimer = undefined;
    this.contactSyncTimer = undefined;
  }

  private async assertServiceAvailable(): Promise<void> {
    await this.request('/server/ok', { method: 'GET' }, 'none');
  }

  private async ensureRemoteInstance(): Promise<void> {
    try {
      const remote = asRecord(unwrapData(await this.request(`/instance/info/${this.instanceId}`, {}, 'admin')));
      const existingToken = stringValue(get(remote, 'token', 'Token'));
      if (existingToken) this.instanceToken = existingToken;
    } catch (error) {
      if (!this.isMissingInstanceError(error)) throw error;
      const created = asRecord(
        unwrapData(
          await this.request(
            '/instance/create',
            {
              method: 'POST',
              body: JSON.stringify({
                instanceId: this.instanceId,
                name: this.config.sessionId,
                token: this.instanceToken,
                advancedSettings: {
                  alwaysOnline: false,
                  rejectCall: false,
                  msgRejectCall: '',
                  readMessages: false,
                  ignoreGroups: false,
                  ignoreStatus: true,
                },
              }),
            },
            'admin',
          ),
        ),
      );
      const createdToken = stringValue(get(created, 'token', 'Token'));
      if (createdToken) this.instanceToken = createdToken;
    }

    if (this.config.proxyUrl) await this.applyProxyConfiguration();
  }

  private async applyProxyConfiguration(): Promise<void> {
    const proxy = new URL(this.config.proxyUrl!);
    const protocol = (this.config.proxyType ?? proxy.protocol.replace(':', '')) || 'http';
    await this.request(
      `/instance/proxy/${this.instanceId}`,
      {
        method: 'POST',
        body: JSON.stringify({
          protocol,
          host: proxy.hostname,
          port: proxy.port || (protocol === 'https' ? '443' : '80'),
          username: decodeURIComponent(proxy.username),
          password: decodeURIComponent(proxy.password),
        }),
      },
      'admin',
    );
  }

  private async connectRemoteInstance(): Promise<void> {
    const response = asRecord(
      unwrapData(
        await this.request(
          '/instance/connect',
          {
            method: 'POST',
            body: JSON.stringify({
              webhookUrl: '',
              subscribe: ['ALL'],
              immediate: true,
              phone: '',
              rabbitmqEnable: 'false',
              websocketEnable: 'true',
              natsEnable: 'false',
            }),
          },
          'instance',
        ),
      ),
    );
    const jid = stringValue(get(response, 'jid', 'Jid', 'JID'));
    if (jid) this.captureIdentity(jid, '');
  }

  private async openWebSocket(): Promise<void> {
    if (this.socket?.readyState === EvolutionGoAdapter.WS_OPEN) return;
    const wsUrl = new URL('ws', this.baseUrl);
    wsUrl.protocol = this.baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('token', this.config.apiKey);
    wsUrl.searchParams.set('instanceId', this.instanceId);

    const socket = this.webSocketFactory(wsUrl.toString());
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to Evolution Go WebSocket')), 10_000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timeout);
          this.websocketReconnectAttempts = 0;
          resolve();
        },
        { once: true },
      );
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Could not connect to Evolution Go WebSocket'));
      });
    });

    socket.addEventListener('message', event => void this.handleWebSocketMessage(event.data));
    socket.addEventListener('close', event => this.handleWebSocketClose(event));
  }

  private handleWebSocketClose(event: { code?: number; reason?: string }): void {
    if (this.socket?.readyState !== EvolutionGoAdapter.WS_OPEN) this.socket = null;
    if (this.intentionalClose || !this.initialized) return;
    this.logger.warn('Evolution Go event WebSocket closed; scheduling local reattachment', {
      sessionId: this.config.sessionId,
      code: event.code,
      reason: event.reason,
      action: 'evolution_ws_closed',
    });
    this.scheduleWebSocketReconnect();
  }

  private scheduleWebSocketReconnect(): void {
    if (this.websocketReconnectTimer || this.intentionalClose || !this.initialized) return;
    const delay = Math.min(
      30_000,
      this.websocketReconnectBaseDelayMs * 2 ** Math.min(this.websocketReconnectAttempts, 5),
    );
    this.websocketReconnectAttempts += 1;
    this.websocketReconnectTimer = setTimeout(() => {
      this.websocketReconnectTimer = undefined;
      void this.openWebSocket().catch(error => {
        this.logger.warn('Evolution Go WebSocket reattachment failed', {
          sessionId: this.config.sessionId,
          reason: this.errorMessage(error),
          action: 'evolution_ws_reconnect_failed',
        });
        this.scheduleWebSocketReconnect();
      });
    }, delay);
  }

  private async handleWebSocketMessage(raw: unknown): Promise<void> {
    try {
      const text = await this.websocketDataToString(raw);
      const wrapper = JSON.parse(text) as JsonRecord;
      const payloadText = stringValue(get(wrapper, 'payload', 'Payload'));
      const payload = payloadText ? (JSON.parse(payloadText) as JsonRecord) : wrapper;
      if (stringValue(get(payload, 'instanceId', 'InstanceId')) !== this.instanceId) return;
      const eventName = stringValue(get(payload, 'event', 'Event')).toLowerCase();

      switch (eventName) {
        case 'qrcode':
          this.handleQRCodeEvent(payload);
          break;
        case 'connected':
        case 'pairsuccess':
          this.handleConnectedEvent(payload);
          break;
        case 'qrsuccess':
          this.setStatus(EngineStatus.AUTHENTICATING);
          break;
        case 'disconnected':
          this.handleDisconnectedEvent('WhatsApp connection closed');
          break;
        case 'connectfailure':
        case 'temporaryban':
        case 'qrtimeout': {
          const data = asRecord(get(payload, 'data', 'Data'));
          const reason = stringValue(get(data, 'Reason', 'reason', 'Message', 'message'));
          this.handleDisconnectedEvent(reason || `Evolution Go reported ${eventName}`);
          break;
        }
        case 'loggedout':
          this.handleLoggedOutEvent(payload);
          break;
        case 'message':
        case 'sendmessage':
          this.handleMessageEvent(payload, eventName === 'sendmessage');
          break;
        case 'receipt':
          this.handleReceiptEvent(payload);
          break;
        case 'historysync':
          this.handleHistorySyncEvent(payload);
          break;
        case 'contact':
        case 'pushname':
          this.scheduleContactSync();
          break;
        default:
          break;
      }
    } catch (error) {
      this.logger.warn('Ignored malformed Evolution Go WebSocket event', {
        sessionId: this.config.sessionId,
        reason: this.errorMessage(error),
        action: 'evolution_event_invalid',
      });
    }
  }

  private handleQRCodeEvent(payload: JsonRecord): void {
    const data = asRecord(get(payload, 'data', 'Data'));
    const qr = stringValue(get(data, 'qrcode', 'qrCode', 'Qrcode'));
    if (!qr) return;
    this.qrCode = qr.split('|')[0];
    this.setStatus(EngineStatus.QR_READY);
    this.callbacks.onQRCode?.(this.qrCode);
  }

  private handleConnectedEvent(payload: JsonRecord): void {
    const data = asRecord(get(payload, 'data', 'Data'));
    this.captureIdentity(stringValue(get(data, 'jid', 'Jid', 'JID')), stringValue(get(data, 'pushName', 'PushName')));
    this.markReady();
  }

  private handleDisconnectedEvent(reason: string): void {
    if (this.intentionalClose || this.status === EngineStatus.DISCONNECTED) return;
    this.readyNotified = false;
    this.setStatus(EngineStatus.DISCONNECTED);
    this.callbacks.onDisconnected?.(reason);
  }

  private handleLoggedOutEvent(payload: JsonRecord): void {
    const data = asRecord(get(payload, 'data', 'Data'));
    const reason = stringValue(get(data, 'Reason', 'reason')) || 'logged out';
    this.readyNotified = false;
    this.setStatus(EngineStatus.FAILED);
    this.callbacks.onError?.(`logged out: ${reason}`);
  }

  private handleMessageEvent(payload: JsonRecord, outgoingEvent: boolean): void {
    this.captureLidMapping(payload);
    const edited = mapEvolutionEdit(payload);
    if (edited) {
      this.callbacks.onMessageEdited?.(edited);
      return;
    }
    const message = mapEvolutionMessage(payload, this.selfJid);
    if (!message) return;
    const data = asRecord(get(payload, 'data', 'Data'));
    const rawMessage = asRecord(get(data, 'Message', 'message'));
    if (rawMessage) this.cacheRawMessage(message.id, rawMessage);
    this.cacheMessage(message);

    const revoked = mapEvolutionRevocation(payload);
    if (revoked) {
      this.callbacks.onMessageRevoked?.(revoked);
      return;
    }
    const reaction = mapEvolutionReaction(payload);
    if (reaction) {
      this.cacheReaction(reaction.messageId, reaction.senderId, reaction.reaction);
      this.callbacks.onMessageReaction?.(reaction);
      return;
    }

    if (outgoingEvent || message.fromMe) this.callbacks.onMessageCreate?.(message);
    else this.callbacks.onMessage?.(message);
  }

  private handleReceiptEvent(payload: JsonRecord): void {
    const receipt = mapEvolutionReceipt(payload);
    if (!receipt) return;
    for (const id of receipt.ids) this.callbacks.onMessageAck?.(id, receipt.status);
  }

  private handleHistorySyncEvent(payload: JsonRecord): void {
    const entries = mapEvolutionHistorySyncEntries(payload, this.selfJid);
    const messages = entries.map(entry => entry.message);
    if (messages.length === 0) return;
    for (const entry of entries) {
      const rawMessage = asRecord(entry.rawMessage);
      if (rawMessage) this.cacheRawMessage(entry.message.id, rawMessage);
      this.cacheMessage(entry.message, true);
    }
    this.callbacks.onHistorySync?.(messages);
  }

  private scheduleContactSync(): void {
    if (this.contactSyncTimer || this.status !== EngineStatus.READY) return;
    this.contactSyncTimer = setTimeout(() => {
      this.contactSyncTimer = undefined;
      void this.getContacts()
        .then(contacts => this.callbacks.onContactsSync?.(contacts))
        .catch(() => undefined);
    }, EvolutionGoAdapter.CONTACT_SYNC_DEBOUNCE_MS);
  }

  private startHealthMonitor(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => {
      void this.refreshRemoteStatus().catch(error => this.handleHealthFailure(error));
    }, this.healthCheckIntervalMs);
  }

  private startQRCodePoll(): void {
    if (this.qrTimer) clearInterval(this.qrTimer);
    this.qrTimer = setInterval(() => {
      if (this.status === EngineStatus.READY || this.intentionalClose) {
        if (this.qrTimer) clearInterval(this.qrTimer);
        this.qrTimer = undefined;
        return;
      }
      void this.refreshQRCode().catch(() => undefined);
    }, 3_000);
  }

  private async refreshRemoteStatus(): Promise<void> {
    const data = asRecord(unwrapData(await this.request('/instance/status', {}, 'instance')));
    this.consecutiveHealthFailures = 0;
    const connected = booleanValue(get(data, 'Connected', 'connected'));
    const loggedIn = booleanValue(get(data, 'LoggedIn', 'loggedIn'));
    const name = stringValue(get(data, 'Name', 'name'));
    if (name) this.pushName = name;

    if (connected && loggedIn) {
      this.markReady();
      return;
    }
    if (this.status === EngineStatus.READY)
      this.handleDisconnectedEvent('Evolution Go reports the session disconnected');
  }

  private handleHealthFailure(error: unknown): void {
    this.consecutiveHealthFailures += 1;
    if (this.consecutiveHealthFailures < 3 || this.intentionalClose) return;
    this.logger.warn('Evolution Go health checks failed repeatedly', {
      sessionId: this.config.sessionId,
      failures: this.consecutiveHealthFailures,
      reason: this.errorMessage(error),
      action: 'evolution_health_failed',
    });
    this.handleDisconnectedEvent('Evolution Go is unavailable');
  }

  private async refreshQRCode(): Promise<void> {
    const data = asRecord(unwrapData(await this.request('/instance/qr', {}, 'instance')));
    const qr = stringValue(get(data, 'qrcode', 'Qrcode', 'qrCode'));
    if (!qr) return;
    const clean = qr.split('|')[0];
    if (clean === this.qrCode) return;
    this.qrCode = clean;
    this.setStatus(EngineStatus.QR_READY);
    this.callbacks.onQRCode?.(clean);
  }

  private markReady(): void {
    this.qrCode = null;
    if (this.qrTimer) clearInterval(this.qrTimer);
    this.qrTimer = undefined;
    this.setStatus(EngineStatus.READY);
    if (!this.readyNotified) {
      this.readyNotified = true;
      this.callbacks.onReady?.(this.phoneNumber ?? '', this.pushName ?? '');
      this.scheduleContactSync();
    }
  }

  private captureIdentity(jid: string, pushName: string): void {
    if (jid) {
      this.selfJid = jid;
      const normalized = toNeutralWhatsAppId(jid);
      if (normalized.endsWith('@c.us')) this.phoneNumber = normalized.split('@')[0];
    }
    if (pushName) this.pushName = pushName;
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  sendTextMessage(chatId: string, text: string, clientMessageId?: string): Promise<MessageResult> {
    return this.sendText(chatId, text, undefined, undefined, clientMessageId);
  }

  sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMedia(chatId, media, 'image');
  }

  sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMedia(chatId, media, 'video');
  }

  sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMedia(chatId, media, 'audio');
  }

  sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMedia(chatId, media, 'document');
  }

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.ensureReady();
    const response = await this.instanceOperation(() =>
      this.request(
        '/send/location',
        {
          method: 'POST',
          body: JSON.stringify({
            number: this.recipient(chatId),
            name: location.description || location.address || 'Location',
            latitude: location.latitude,
            longitude: location.longitude,
            address: location.address || location.description || 'Location',
            id: location.clientMessageId,
          }),
        },
        'instance',
      ),
    );
    return this.messageResult(response);
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.ensureReady();
    const response = await this.instanceOperation(() =>
      this.request(
        '/send/contact',
        {
          method: 'POST',
          body: JSON.stringify({
            number: this.recipient(chatId),
            vcard: { fullName: contact.name, organization: '', phone: contact.number },
            id: contact.clientMessageId,
          }),
        },
        'instance',
      ),
    );
    return this.messageResult(response);
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const response = await this.instanceOperation(() =>
      this.request(
        '/send/sticker',
        {
          method: 'POST',
          body: JSON.stringify({
            number: this.recipient(chatId),
            sticker: this.mediaPayload(media),
            id: media.clientMessageId,
          }),
        },
        'instance',
      ),
    );
    return this.messageResult(response);
  }

  async replyToMessage(
    chatId: string,
    quotedMsgId: string,
    text: string,
    clientMessageId?: string,
  ): Promise<MessageResult> {
    return this.sendText(chatId, text, { messageId: quotedMsgId, participant: '' }, undefined, clientMessageId);
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReady();
    const original = this.messageCache.get(fromChatId)?.find(message => message.id === messageId);
    if (!original) throw new Error(`Message ${messageId} is not available in the local history cache`);
    if (original.media) {
      const source = original.media.url ?? original.media.data;
      if (!source) throw new Error(`Media for message ${messageId} is not available`);
      return this.sendMedia(
        toChatId,
        {
          mimetype: original.media.mimetype,
          data: source,
          filename: original.media.filename,
          caption: original.body,
        },
        original.type === 'voice' ? 'audio' : original.type,
        undefined,
        1,
      );
    }
    return this.sendText(toChatId, original.body, undefined, 1);
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.ensureReady();
    const original = this.messageCache.get(chatId)?.find(message => message.id === messageId);
    await this.instanceOperation(() =>
      this.request(
        '/message/react',
        {
          method: 'POST',
          body: JSON.stringify({
            number: toEvolutionWhatsAppId(chatId),
            reaction: emoji,
            id: messageId,
            fromMe: original?.fromMe ?? false,
            participant: original?.author ? toEvolutionWhatsAppId(original.author) : undefined,
          }),
        },
        'instance',
      ),
    );
    this.cacheReaction(messageId, this.selfJid, emoji);
  }

  getMessageReactions(_chatId: string, messageId: string): Promise<MessageReaction[]> {
    const values = this.reactions.get(messageId);
    if (!values) return Promise.resolve([]);
    const grouped = new Map<string, Array<{ senderId: string; emoji: string; timestamp: number }>>();
    for (const [senderId, emoji] of values) {
      if (!emoji) continue;
      const senders = grouped.get(emoji) ?? [];
      senders.push({ senderId, emoji, timestamp: Math.floor(Date.now() / 1000) });
      grouped.set(emoji, senders);
    }
    return Promise.resolve([...grouped].map(([emoji, senders]) => ({ emoji, senders })));
  }

  private async sendText(
    chatId: string,
    text: string,
    quoted?: { messageId: string; participant: string },
    forwardingScore?: number,
    clientMessageId?: string,
  ): Promise<MessageResult> {
    this.ensureReady();
    const response = await this.instanceOperation(() =>
      this.request(
        '/send/text',
        {
          method: 'POST',
          body: JSON.stringify({
            number: this.recipient(chatId),
            text,
            quoted,
            forwardingScore,
            id: clientMessageId,
          }),
        },
        'instance',
      ),
    );
    return this.messageResult(response);
  }

  private async sendMedia(
    chatId: string,
    media: MediaInput,
    type: string,
    quoted?: { messageId: string; participant: string },
    forwardingScore?: number,
  ): Promise<MessageResult> {
    this.ensureReady();
    const response = await this.instanceOperation(() =>
      this.request(
        '/send/media',
        {
          method: 'POST',
          body: JSON.stringify({
            number: this.recipient(chatId),
            url: this.mediaPayload(media),
            type,
            caption: media.caption || '',
            filename: media.filename || '',
            quoted,
            forwardingScore,
            id: media.clientMessageId,
          }),
        },
        'instance',
      ),
    );
    return this.messageResult(response);
  }

  private mediaPayload(media: MediaInput): string {
    if (Buffer.isBuffer(media.data)) return media.data.toString('base64');
    const data = media.data.trim();
    const dataUrl = data.match(/^data:[^;]+;base64,(.*)$/s);
    return dataUrl ? dataUrl[1] : data;
  }

  private messageResult(response: unknown): MessageResult {
    const data = asRecord(unwrapData(response));
    const info = asRecord(get(data, 'Info', 'info'));
    const id = stringValue(get(info, 'ID', 'id')) || stringValue(get(data, 'id', 'messageId'));
    const rawTimestamp = get(info, 'Timestamp', 'timestamp');
    const parsedDate = Date.parse(stringValue(rawTimestamp));
    const timestamp = Number.isFinite(parsedDate)
      ? Math.floor(parsedDate / 1000)
      : numberValue(rawTimestamp, Math.floor(Date.now() / 1000));
    if (!id) throw new Error('Evolution Go returned a successful send without a message id');
    return { id, timestamp: timestamp > 10_000_000_000 ? Math.floor(timestamp / 1000) : timestamp };
  }

  // ---------------------------------------------------------------------------
  // Contacts
  // ---------------------------------------------------------------------------

  async getContacts(): Promise<Contact[]> {
    this.ensureReady();
    const response = unwrapData(await this.instanceOperation(() => this.request('/user/contacts', {}, 'instance')));
    if (!Array.isArray(response)) return [];
    return response
      .map(item => this.mapContact(item))
      .filter((contact): contact is Contact => contact !== null)
      .sort((a, b) => (a.name || a.pushName || a.number).localeCompare(b.name || b.pushName || b.number));
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    const neutral = toNeutralWhatsAppId(contactId);
    const contacts = await this.getContacts();
    return contacts.find(contact => contact.id === neutral || contact.number === neutral.split('@')[0]) ?? null;
  }

  async checkNumberExists(number: string): Promise<boolean> {
    return (await this.getNumberId(number)) !== null;
  }

  async getNumberId(number: string): Promise<string | null> {
    this.ensureReady();
    const response = asRecord(
      unwrapData(
        await this.instanceOperation(() =>
          this.request(
            '/user/check',
            { method: 'POST', body: JSON.stringify({ number: [number], formatJid: true }) },
            'instance',
          ),
        ),
      ),
    );
    const users = get(response, 'Users', 'users');
    if (!Array.isArray(users)) return null;
    const user = asRecord(users[0]);
    if (!booleanValue(get(user, 'IsInWhatsapp', 'isInWhatsapp'))) return null;
    return toNeutralWhatsAppId(get(user, 'JID', 'jid', 'RemoteJID', 'remoteJID')) || null;
  }

  resolveContactPhone(contactId: string): Promise<string | null> {
    const normalized = toNeutralWhatsAppId(contactId);
    if (normalized.endsWith('@c.us')) return Promise.resolve(normalized.split('@')[0]);
    return Promise.resolve(this.lidPhoneMappings.get(normalized) ?? null);
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    this.ensureReady();
    try {
      const data = asRecord(
        unwrapData(
          await this.instanceOperation(() =>
            this.request(
              '/user/avatar',
              { method: 'POST', body: JSON.stringify({ number: this.recipient(contactId), preview: false }) },
              'instance',
            ),
          ),
        ),
      );
      return stringValue(get(data, 'URL', 'url')) || null;
    } catch (error) {
      if (/no profile picture/i.test(this.errorMessage(error))) return null;
      throw error;
    }
  }

  async blockContact(contactId: string): Promise<void> {
    await this.contactAction('/user/block', contactId);
  }

  async unblockContact(contactId: string): Promise<void> {
    await this.contactAction('/user/unblock', contactId);
  }

  private async contactAction(path: string, contactId: string): Promise<void> {
    this.ensureReady();
    await this.instanceOperation(() =>
      this.request(path, { method: 'POST', body: JSON.stringify({ number: this.recipient(contactId) }) }, 'instance'),
    );
  }

  private mapContact(value: unknown): Contact | null {
    const data = asRecord(value);
    const id = toNeutralWhatsAppId(get(data, 'Jid', 'JID', 'jid'));
    if (!id || id.endsWith('@g.us') || id.endsWith('@broadcast')) return null;
    const number = id.endsWith('@c.us') ? id.split('@')[0] : this.lidPhoneMappings.get(id) || '';
    return {
      id,
      number,
      name:
        stringValue(get(data, 'FullName', 'fullName')) ||
        stringValue(get(data, 'FirstName', 'firstName')) ||
        stringValue(get(data, 'BusinessName', 'businessName')) ||
        undefined,
      pushName: stringValue(get(data, 'PushName', 'pushName')) || undefined,
      isMyContact: booleanValue(get(data, 'Found', 'found')),
      isBlocked: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Groups
  // ---------------------------------------------------------------------------

  async getGroups(): Promise<Group[]> {
    this.ensureReady();
    const response = unwrapData(await this.instanceOperation(() => this.request('/group/list', {}, 'instance')));
    if (!Array.isArray(response)) return [];
    return response.map(value => this.mapGroup(value)).filter((group): group is Group => group !== null);
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.ensureReady();
    const response = unwrapData(
      await this.instanceOperation(() =>
        this.request(
          '/group/info',
          { method: 'POST', body: JSON.stringify({ groupJid: toEvolutionWhatsAppId(groupId) }) },
          'instance',
        ),
      ),
    );
    return this.mapGroupInfo(response);
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.ensureReady();
    const data = asRecord(
      unwrapData(
        await this.instanceOperation(() =>
          this.request(
            '/group/create',
            {
              method: 'POST',
              body: JSON.stringify({ groupName: name, participants: participants.map(toEvolutionWhatsAppId) }),
            },
            'instance',
          ),
        ),
      ),
    );
    const id = toNeutralWhatsAppId(get(data, 'jid', 'JID'));
    return { id, name: stringValue(get(data, 'name', 'Name')) || name };
  }

  addParticipants(groupId: string, participants: string[]): Promise<void> {
    return this.updateParticipants(groupId, participants, 'add');
  }

  removeParticipants(groupId: string, participants: string[]): Promise<void> {
    return this.updateParticipants(groupId, participants, 'remove');
  }

  promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    return this.updateParticipants(groupId, participants, 'promote');
  }

  demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    return this.updateParticipants(groupId, participants, 'demote');
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.ensureReady();
    await this.instanceOperation(() =>
      this.request(
        '/group/leave',
        { method: 'POST', body: JSON.stringify({ groupJid: toEvolutionWhatsAppId(groupId) }) },
        'instance',
      ),
    );
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.ensureReady();
    await this.instanceOperation(() =>
      this.request(
        '/group/name',
        { method: 'POST', body: JSON.stringify({ groupJid: toEvolutionWhatsAppId(groupId), name: subject }) },
        'instance',
      ),
    );
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.ensureReady();
    await this.instanceOperation(() =>
      this.request(
        '/group/description',
        { method: 'POST', body: JSON.stringify({ groupJid: toEvolutionWhatsAppId(groupId), description }) },
        'instance',
      ),
    );
  }

  getGroupInviteCode(groupId: string): Promise<string> {
    return this.groupInviteCode(groupId, false);
  }

  revokeGroupInviteCode(groupId: string): Promise<string> {
    return this.groupInviteCode(groupId, true);
  }

  private async updateParticipants(groupId: string, participants: string[], action: string): Promise<void> {
    this.ensureReady();
    await this.instanceOperation(() =>
      this.request(
        '/group/participant',
        {
          method: 'POST',
          body: JSON.stringify({
            groupJid: toEvolutionWhatsAppId(groupId),
            number: toEvolutionWhatsAppId(groupId),
            participants: participants.map(toEvolutionWhatsAppId),
            action,
          }),
        },
        'instance',
      ),
    );
  }

  private async groupInviteCode(groupId: string, reset: boolean): Promise<string> {
    this.ensureReady();
    const response = unwrapData(
      await this.instanceOperation(() =>
        this.request(
          '/group/invitelink',
          { method: 'POST', body: JSON.stringify({ groupJid: toEvolutionWhatsAppId(groupId), reset }) },
          'instance',
        ),
      ),
    );
    const link = stringValue(response);
    return link.split('/').pop() || link;
  }

  private mapGroup(value: unknown): Group | null {
    const data = asRecord(value);
    const id = toNeutralWhatsAppId(get(data, 'JID', 'jid'));
    if (!id) return null;
    const nameData = asRecord(get(data, 'GroupName', 'groupName'));
    const participants = get(data, 'Participants', 'participants');
    const linkedParent = toNeutralWhatsAppId(get(data, 'LinkedParentJID', 'linkedParentJID'));
    return {
      id,
      name:
        stringValue(get(nameData, 'Name', 'name')) ||
        stringValue(get(data, 'Name', 'name', 'GroupName', 'groupName')) ||
        id,
      participantsCount: Array.isArray(participants) ? participants.length : undefined,
      linkedParentJID: linkedParent || null,
    };
  }

  private mapGroupInfo(value: unknown): GroupInfo | null {
    const data = asRecord(value);
    const base = this.mapGroup(value);
    if (!data || !base) return null;
    const participants = get(data, 'Participants', 'participants');
    const participantList = Array.isArray(participants)
      ? participants.map(value => {
          const participant = asRecord(value);
          const id = toNeutralWhatsAppId(get(participant, 'JID', 'jid'));
          const admin = stringValue(get(participant, 'IsAdmin', 'isAdmin', 'Admin', 'admin')).toLowerCase();
          return {
            id,
            number: id.split('@')[0],
            isAdmin: admin === 'admin' || admin === 'superadmin' || booleanValue(admin),
            isSuperAdmin: admin === 'superadmin',
          };
        })
      : [];
    const descriptionData = asRecord(get(data, 'GroupTopic', 'groupTopic'));
    return {
      ...base,
      description: stringValue(get(descriptionData, 'Topic', 'topic')) || undefined,
      owner: toNeutralWhatsAppId(get(data, 'OwnerJID', 'ownerJID')) || undefined,
      createdAt: numberValue(get(data, 'GroupCreated', 'groupCreated')) || undefined,
      participants: participantList,
      isAnnounce: booleanValue(get(data, 'IsAnnounce', 'isAnnounce')),
      isReadOnly: booleanValue(get(data, 'IsLocked', 'isLocked')),
    };
  }

  // ---------------------------------------------------------------------------
  // History, delivery, and chat state
  // ---------------------------------------------------------------------------

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    this.ensureReady();
    await this.instanceOperation(() =>
      this.request(
        '/message/edit',
        {
          method: 'POST',
          body: JSON.stringify({ chat: toEvolutionWhatsAppId(chatId), messageId, message: text }),
        },
        'instance',
      ),
    );
  }

  async deleteMessage(chatId: string, messageId: string, forEveryone = true): Promise<void> {
    this.ensureReady();
    if (!forEveryone) throw new EngineNotSupportedError('deleteMessage (delete-for-me)');
    await this.instanceOperation(() =>
      this.request(
        '/message/delete',
        {
          method: 'POST',
          body: JSON.stringify({ chat: toEvolutionWhatsAppId(chatId), messageId }),
        },
        'instance',
      ),
    );
  }

  async getChatHistory(chatId: string, limit = 100, includeMedia = false): Promise<IncomingMessage[]> {
    const history = this.messageCache.get(chatId) ?? [];
    const selected = history.slice(-Math.max(1, limit));
    if (selected.length > 0 && selected.length < limit) void this.requestHistoryBackfill(chatId, selected[0], limit);
    if (!includeMedia) return selected;

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const message = selected[nextIndex++];
        if (!message) return;
        if (!message.media || message.media.data || message.media.url) continue;
        try {
          const media = await this.downloadMessageMedia(message.id, message.media.mimetype);
          message.media = { ...message.media, ...media };
        } catch (error) {
          this.logger.debug(`Evolution Go media backfill unavailable for ${message.id}`, {
            sessionId: this.config.sessionId,
            reason: this.errorMessage(error),
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, selected.length) }, () => worker()));
    return selected;
  }

  private async requestHistoryBackfill(chatId: string, anchor: IncomingMessage, requestedCount: number): Promise<void> {
    const lastRequest = this.historyBackfillRequests.get(chatId) ?? 0;
    if (Date.now() - lastRequest < 30_000 || this.status !== EngineStatus.READY) return;
    this.historyBackfillRequests.set(chatId, Date.now());
    try {
      await this.instanceOperation(() =>
        this.request(
          '/chat/history-sync',
          {
            method: 'POST',
            body: JSON.stringify({
              messageInfo: {
                Chat: toEvolutionWhatsAppId(chatId),
                IsFromMe: anchor.fromMe,
                IsGroup: anchor.isGroup,
                ID: anchor.id,
                Timestamp: new Date(anchor.timestamp * 1000).toISOString(),
              },
              count: Math.min(Math.max(requestedCount, 1), 500),
            }),
          },
          'instance',
        ),
      );
    } catch (error) {
      this.logger.debug(`Evolution Go history backfill request failed for ${chatId}`, {
        sessionId: this.config.sessionId,
        reason: this.errorMessage(error),
      });
    }
  }

  private async downloadMessageMedia(
    messageId: string,
    fallbackMimetype: string,
  ): Promise<{ data: string; mimetype: string }> {
    const rawMessage = this.rawMessages.get(messageId);
    if (!rawMessage) throw new Error('Raw history media descriptor is no longer cached');
    const response = asRecord(
      unwrapData(
        await this.instanceOperation(() =>
          this.request(
            '/message/downloadmedia',
            { method: 'POST', body: JSON.stringify({ message: rawMessage }) },
            'instance',
          ),
        ),
      ),
    );
    const data = stringValue(get(response, 'base64', 'Base64'));
    if (!data) throw new Error('Evolution Go returned no media data');
    this.rawMessages.delete(messageId);
    const dataUrlMimetype = data.match(/^data:([^;,]+)/i)?.[1];
    return { data, mimetype: dataUrlMimetype || fallbackMimetype };
  }

  private cacheRawMessage(messageId: string, rawMessage: JsonRecord): void {
    this.rawMessages.set(messageId, rawMessage);
    while (this.rawMessages.size > EvolutionGoAdapter.MAX_RAW_MEDIA_DESCRIPTORS) {
      const oldest = this.rawMessages.keys().next().value as string | undefined;
      if (!oldest) break;
      this.rawMessages.delete(oldest);
    }
  }

  getChats(): Promise<ChatSummary[]> {
    return Promise.resolve([...this.chatCache.values()].sort((a, b) => b.timestamp - a.timestamp));
  }

  async sendSeen(chatId: string): Promise<boolean> {
    this.ensureReady();
    const messages = this.messageCache.get(chatId) ?? [];
    const ids = messages
      .filter(message => !message.fromMe)
      .slice(-50)
      .map(message => message.id);
    if (ids.length === 0) return false;
    await this.instanceOperation(() =>
      this.request(
        '/message/markread',
        { method: 'POST', body: JSON.stringify({ id: ids, number: this.recipient(chatId) }) },
        'instance',
      ),
    );
    const chat = this.chatCache.get(chatId);
    if (chat) chat.unreadCount = 0;
    return true;
  }

  deleteChat(): Promise<boolean> {
    return this.unsupported('deleteChat');
  }

  async sendChatState(chatId: string, state: ChatState): Promise<void> {
    this.ensureReady();
    await this.instanceOperation(() =>
      this.request(
        '/message/presence',
        {
          method: 'POST',
          body: JSON.stringify({
            number: this.recipient(chatId),
            state: state === 'paused' ? 'paused' : 'composing',
            isAudio: state === 'recording',
            delay: 0,
          }),
        },
        'instance',
      ),
    );
  }

  private cacheMessage(message: IncomingMessage, isHistoryBackfill = false): void {
    const history = this.messageCache.get(message.chatId) ?? [];
    const index = history.findIndex(existing => existing.id === message.id);
    if (index >= 0) history[index] = { ...history[index], ...message };
    else history.push(message);
    history.sort((a, b) => a.timestamp - b.timestamp);
    if (history.length > EvolutionGoAdapter.MAX_CACHE_MESSAGES_PER_CHAT) {
      history.splice(0, history.length - EvolutionGoAdapter.MAX_CACHE_MESSAGES_PER_CHAT);
    }
    this.messageCache.set(message.chatId, history);
    const previous = this.chatCache.get(message.chatId);
    const isNewest = !previous || message.timestamp >= previous.timestamp;
    const name = message.contact?.name || message.contact?.pushName || previous?.name || message.chatId;
    this.chatCache.set(message.chatId, {
      id: message.chatId,
      name,
      isGroup: message.isGroup,
      unreadCount: (previous?.unreadCount ?? 0) + (!isHistoryBackfill && !message.fromMe ? 1 : 0),
      timestamp: Math.max(previous?.timestamp ?? 0, message.timestamp),
      lastMessage: isNewest
        ? message.body || (message.type !== 'unknown' ? `[${message.type}]` : previous?.lastMessage)
        : previous?.lastMessage,
    });
  }

  private cacheReaction(messageId: string, senderId: string, reaction: string): void {
    const values = this.reactions.get(messageId) ?? new Map<string, string>();
    if (reaction) values.set(senderId, reaction);
    else values.delete(senderId);
    this.reactions.set(messageId, values);
  }

  private captureLidMapping(payload: JsonRecord): void {
    const data = asRecord(get(payload, 'data', 'Data'));
    const info = asRecord(get(data, 'Info', 'info'));
    const sender = toNeutralWhatsAppId(get(info, 'Sender', 'sender'));
    const senderAlt = toNeutralWhatsAppId(get(info, 'SenderAlt', 'senderAlt'));
    if (sender.endsWith('@lid') && senderAlt.endsWith('@c.us'))
      this.lidPhoneMappings.set(sender, senderAlt.split('@')[0]);
    if (senderAlt.endsWith('@lid') && sender.endsWith('@c.us'))
      this.lidPhoneMappings.set(senderAlt, sender.split('@')[0]);
  }

  // ---------------------------------------------------------------------------
  // Labels, channels, and statuses supported by Evolution Go
  // ---------------------------------------------------------------------------

  async getLabels(): Promise<Label[]> {
    this.ensureReady();
    const response = unwrapData(await this.instanceOperation(() => this.request('/label/list', {}, 'instance')));
    if (!Array.isArray(response)) return [];
    return response.map(value => {
      const data = asRecord(value);
      return {
        id: stringValue(get(data, 'LabelID', 'labelId', 'id')),
        name: stringValue(get(data, 'LabelName', 'labelName', 'name')),
        hexColor: stringValue(get(data, 'LabelColor', 'labelColor', 'color')),
      };
    });
  }

  async getLabelById(labelId: string): Promise<Label | null> {
    return (await this.getLabels()).find(label => label.id === labelId) ?? null;
  }

  getChatLabels(): Promise<Label[]> {
    return this.unsupported('getChatLabels');
  }

  addLabelToChat(chatId: string, labelId: string): Promise<void> {
    return this.chatLabelAction('/label/chat', chatId, labelId);
  }

  removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    return this.chatLabelAction('/unlabel/chat', chatId, labelId);
  }

  private async chatLabelAction(path: string, chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    await this.instanceOperation(() =>
      this.request(
        path,
        { method: 'POST', body: JSON.stringify({ number: this.recipient(chatId), labelId }) },
        'instance',
      ),
    );
  }

  async getSubscribedChannels(): Promise<Channel[]> {
    this.ensureReady();
    const response = unwrapData(await this.instanceOperation(() => this.request('/newsletter/list', {}, 'instance')));
    if (!Array.isArray(response)) return [];
    return response.map(value => this.mapChannel(value));
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    this.ensureReady();
    const response = unwrapData(
      await this.instanceOperation(() =>
        this.request(
          '/newsletter/info',
          { method: 'POST', body: JSON.stringify({ newsletterId: toEvolutionWhatsAppId(channelId) }) },
          'instance',
        ),
      ),
    );
    return response ? this.mapChannel(response) : null;
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    this.ensureReady();
    const response = unwrapData(
      await this.instanceOperation(() =>
        this.request(
          '/newsletter/subscribe',
          { method: 'POST', body: JSON.stringify({ newsletterId: inviteCode }) },
          'instance',
        ),
      ),
    );
    return this.mapChannel(response);
  }

  unsubscribeFromChannel(): Promise<void> {
    return this.unsupported('unsubscribeFromChannel');
  }

  async getChannelMessages(channelId: string, limit = 50): Promise<ChannelMessage[]> {
    this.ensureReady();
    const response = unwrapData(
      await this.instanceOperation(() =>
        this.request(
          '/newsletter/messages',
          {
            method: 'POST',
            body: JSON.stringify({ newsletterId: toEvolutionWhatsAppId(channelId), count: limit }),
          },
          'instance',
        ),
      ),
    );
    if (!Array.isArray(response)) return [];
    return response.map(value => {
      const data = asRecord(value);
      const mapped = mapEvolutionMessage(data, this.selfJid);
      return {
        id: mapped?.id ?? stringValue(get(data, 'ID', 'id')),
        body: mapped?.body ?? '',
        timestamp: mapped?.timestamp ?? 0,
        hasMedia: Boolean(mapped?.media),
        mediaUrl: mapped?.media?.url,
      };
    });
  }

  postTextStatus(text: string, options?: TextStatusOptions): Promise<StatusResult> {
    return this.sendStatus('/send/status/text', { text, ...options });
  }

  postImageStatus(media: MediaInput, caption?: string): Promise<StatusResult> {
    return this.sendStatus('/send/status/media', {
      url: this.mediaPayload(media),
      type: 'image',
      caption: caption ?? media.caption ?? '',
    });
  }

  postVideoStatus(media: MediaInput, caption?: string): Promise<StatusResult> {
    return this.sendStatus('/send/status/media', {
      url: this.mediaPayload(media),
      type: 'video',
      caption: caption ?? media.caption ?? '',
    });
  }

  getContactStatuses(): Promise<Status[]> {
    return this.unsupported('getContactStatuses');
  }

  getContactStatus(): Promise<Status[]> {
    return this.unsupported('getContactStatus');
  }

  deleteStatus(): Promise<void> {
    return this.unsupported('deleteStatus');
  }

  private async sendStatus(path: string, body: JsonRecord): Promise<StatusResult> {
    this.ensureReady();
    const response = await this.instanceOperation(() =>
      this.request(path, { method: 'POST', body: JSON.stringify(body) }, 'instance'),
    );
    const result = this.messageResult(response);
    const timestamp = new Date(result.timestamp * 1000);
    return { statusId: result.id, timestamp, expiresAt: new Date(timestamp.getTime() + 24 * 60 * 60 * 1000) };
  }

  private mapChannel(value: unknown): Channel {
    const data = asRecord(value);
    const metadata = asRecord(get(data, 'ThreadMetadata', 'threadMetadata', 'Metadata', 'metadata'));
    return {
      id: toNeutralWhatsAppId(get(data, 'ID', 'id', 'JID', 'jid')),
      name: stringValue(get(metadata, 'Name', 'name')) || stringValue(get(data, 'Name', 'name')),
      description:
        stringValue(get(metadata, 'Description', 'description')) ||
        stringValue(get(data, 'Description', 'description')),
      inviteCode: stringValue(get(data, 'InviteCode', 'inviteCode')) || undefined,
      subscriberCount: numberValue(get(metadata, 'SubscriberCount', 'subscriberCount')) || undefined,
      picture: stringValue(get(metadata, 'Picture', 'picture')) || undefined,
      verified: booleanValue(get(metadata, 'Verified', 'verified')),
      createdAt: numberValue(get(data, 'CreatedAt', 'createdAt')) || undefined,
    };
  }

  // Catalog is not exposed by Evolution Go 0.7.2.
  getCatalog(): Promise<Catalog | null> {
    return this.unsupported('getCatalog');
  }

  getProducts(): Promise<PaginatedProducts> {
    return this.unsupported('getProducts');
  }

  getProduct(): Promise<Product | null> {
    return this.unsupported('getProduct');
  }

  sendProduct(): Promise<MessageResult> {
    return this.unsupported('sendProduct');
  }

  sendCatalog(): Promise<MessageResult> {
    return this.unsupported('sendCatalog');
  }

  // ---------------------------------------------------------------------------
  // Status and transport helpers
  // ---------------------------------------------------------------------------

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (this.status === EngineStatus.READY) throw new Error('Session is already authenticated');
    const data = asRecord(
      unwrapData(
        await this.request(
          '/instance/pair',
          {
            method: 'POST',
            body: JSON.stringify({ phone: phoneNumber.replace(/\D/g, ''), subscribe: ['ALL'] }),
          },
          'instance',
        ),
      ),
    );
    const code = stringValue(get(data, 'PairingCode', 'pairingCode'));
    if (!code) throw new Error('Evolution Go did not return a pairing code');
    this.setStatus(EngineStatus.AUTHENTICATING);
    return code;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  private recipient(value: string): string {
    const id = toEvolutionWhatsAppId(value);
    return id.includes('@') ? id : id.replace(/\D/g, '');
  }

  private ensureReady(): void {
    if (this.status !== EngineStatus.READY) throw new EngineNotReadyError(WHATSAPP_SESSION_DISCONNECTED_MESSAGE);
  }

  private setStatus(status: EngineStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.callbacks.onStateChanged?.(status);
  }

  private async instanceOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (this.isAlreadyDisconnectedError(error)) {
        this.handleDisconnectedEvent('Evolution Go reports the WhatsApp client disconnected');
        throw new EngineNotReadyError(WHATSAPP_SESSION_DISCONNECTED_MESSAGE);
      }
      throw error;
    }
  }

  private async request(
    path: string,
    init: RequestInit = {},
    auth: 'none' | 'admin' | 'instance' = 'instance',
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (auth === 'admin') headers.set('apikey', this.config.apiKey);
    if (auth === 'instance') headers.set('apikey', this.instanceToken);

    try {
      const response = await this.fetchImpl(new URL(path.replace(/^\//, ''), this.baseUrl), {
        ...init,
        headers,
        signal: controller.signal,
      });
      const bodyText = await response.text();
      let body: unknown = undefined;
      if (bodyText) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = bodyText;
        }
      }
      if (!response.ok) throw new EvolutionGoApiError({ status: response.status, path, body });
      return body;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Evolution Go request timed out: ${path}`, { cause: error });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private isMissingInstanceError(error: unknown): boolean {
    return error instanceof EvolutionGoApiError && /not found|record not found|instance.*exist/i.test(error.message);
  }

  private isAlreadyDisconnectedError(error: unknown): boolean {
    return /no active session|client disconnected|not connected|connection closed|instance.*disconnected/i.test(
      this.errorMessage(error),
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private deriveInstanceId(sessionId: string): string {
    const slug = sessionId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24);
    const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
    return `aurora-${slug || 'session'}-${hash}`;
  }

  private async websocketDataToString(value: unknown): Promise<string> {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
    if (ArrayBuffer.isView(value))
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value.text();
    return String(value);
  }

  private readonly defaultWebSocketFactory = (url: string): EvolutionWebSocket => {
    if (typeof WebSocket === 'undefined') {
      throw new Error('This Node.js runtime does not provide a WebSocket client');
    }
    return new WebSocket(url);
  };

  private unsupported<T>(method: string): Promise<T> {
    return Promise.reject(new EngineNotSupportedError(method));
  }
}
