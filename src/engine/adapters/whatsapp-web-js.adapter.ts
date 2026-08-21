import { EventEmitter } from 'events';
import { Client, LocalAuth, Message as WwebjsMessage, MessageMedia, MessageTypes, WAState } from 'whatsapp-web.js';
import * as qrcode from 'qrcode';
import * as path from 'path';
import {
  IWhatsAppEngine,
  EngineStatus,
  EngineEventCallbacks,
  MessageResult,
  MediaInput,
  IncomingMessage,
  Contact,
  Group,
  GroupInfo,
  GroupParticipant,
  LocationInput,
  ContactCard,
  MessageReaction,
  Label,
  Channel,
  ChannelMessage,
  Status,
  TextStatusOptions,
  StatusResult,
  Catalog,
  Product,
  ProductQueryOptions,
  PaginatedProducts,
  ChatSummary,
  ChatState,
  DeliveryStatus,
  RevokedMessage,
  ReactionEvent,
} from '../interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { RecipientUnreachableError } from '../../common/errors/recipient-unreachable.error';
import { assertSafeFetchUrl } from '../../common/security/ssrf-guard';
import {
  GroupChat,
  GroupMetadataRaw,
  MessageWithReactions,
  BusinessClient,
  WwjsChannelData,
  GroupCreateResult,
} from '../types/whatsapp-web-js.types';
import { buildIncomingMessageBase } from './message-mapper';
import { resolveWebVersionPin } from '../wa-web-version';

export { resolveWebVersionPin } from '../wa-web-version';

/** Default cap on a server-side media download: 50 MiB (overridable via MEDIA_DOWNLOAD_MAX_BYTES). */
const DEFAULT_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
/** Default timeout for a server-side media download: 30s (overridable via MEDIA_DOWNLOAD_TIMEOUT_MS). */
const DEFAULT_MEDIA_TIMEOUT_MS = 30_000;
const READY_RECONCILE_INTERVAL_MS = 2000;
export const READY_RECONCILE_TIMEOUT_MS = 90_000;
export const READY_RECONCILE_BRIDGE_RELOAD_GRACE_MS = 45_000;

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Map a whatsapp-web.js MessageAck integer to the neutral DeliveryStatus.
 * wwebjs: -1 ERROR, 0 PENDING, 1 SERVER (sent), 2 DEVICE (delivered), 3 READ, 4 PLAYED.
 * PLAYED collapses to `read` (preserving prior behaviour, which treated ack>=3 as read).
 */
export function wwebjsAckToDeliveryStatus(ack: number): DeliveryStatus {
  if (ack < 0) return 'failed';
  if (ack >= 3) return 'read';
  if (ack === 2) return 'delivered';
  if (ack === 1) return 'sent';
  return 'pending';
}

/**
 * Fetch remote media for sending, with an SSRF host guard, a byte cap, and a timeout.
 * The guard runs BEFORE any network call, so an internal/reserved URL throws `SsrfBlockedError`
 * and no outbound socket is opened. The byte cap (node-fetch `size`) and `AbortSignal` timeout
 * bound memory use and hang time. `unsafeMime` is left at its default (false) to preserve the
 * existing MIME-detection behavior.
 */
export async function loadRemoteMedia(url: string): Promise<MessageMedia> {
  await assertSafeFetchUrl(url);
  return MessageMedia.fromUrl(url, {
    reqOptions: {
      size: positiveIntFromEnv('MEDIA_DOWNLOAD_MAX_BYTES', DEFAULT_MEDIA_MAX_BYTES),
      signal: AbortSignal.timeout(positiveIntFromEnv('MEDIA_DOWNLOAD_TIMEOUT_MS', DEFAULT_MEDIA_TIMEOUT_MS)),
      // Never follow redirects: the SSRF guard only validated the original host, so a
      // followed 3xx could reach an internal target. node-fetch rejects on redirect.
      redirect: 'error',
    },
  });
}

export interface WhatsAppWebJsConfig {
  sessionId: string;
  sessionDataPath: string;
  puppeteer?: {
    headless?: boolean;
    args?: string[];
    executablePath?: string;
  };
  // Phase 3: Proxy per session
  proxy?: {
    url: string;
    type: 'http' | 'https' | 'socks4' | 'socks5';
  };
}

/**
 * Extracts the JID of the parent community a group is linked to, if any.
 * The field name has varied across whatsapp-web.js/WA Web versions, so
 * known candidates are checked in order.
 */
export function extractLinkedParentJID(groupMetadata?: GroupMetadataRaw): string | null {
  const candidate =
    groupMetadata?.parentGroup ?? groupMetadata?.linkedParentGroup ?? groupMetadata?.linkedParent ?? null;

  if (!candidate) {
    return null;
  }

  if (typeof candidate === 'string') {
    return candidate;
  }

  return candidate._serialized ?? null;
}

/** whatsapp-web.js exposes this recipient-addressing failure only as message text. */
export function isNoLidForUserError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('No LID for user');
}

class UnresolvedWwebjsRecipientError extends Error {
  constructor(recipient: string) {
    super(`whatsapp-web.js returned no chat/message for recipient ${recipient}`);
  }
}

interface RuntimeWid {
  _serialized?: string;
  user?: string;
  server?: string;
}

interface WwebjsRuntimeWindow {
  require(moduleName: string): unknown;
}

export class WhatsAppWebJsAdapter extends EventEmitter implements IWhatsAppEngine {
  private client: Client | null = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};
  private readyReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private readyReconcileStartedAt = 0;
  private readyReconcileProbeInFlight = false;
  private lastProbeStateConnected = false;
  private readyReconcileReloadAttempted = false;
  private tearingDown = false;
  private readonly resolvedSendIds = new Map<string, string>();
  private readonly lidToPhone = new Map<string, string>();

  constructor(private readonly config: WhatsAppWebJsConfig) {
    super();
  }

  private readonly logger = createLogger('WhatsAppWebJsAdapter');

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.setStatus(EngineStatus.INITIALIZING);

    try {
      // Build puppeteer args, including proxy if configured
      const puppeteerArgs = this.config.puppeteer?.args || [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ];

      // Add proxy configuration if provided
      if (this.config.proxy) {
        puppeteerArgs.push(`--proxy-server=${this.config.proxy.url}`);
        this.logger.log(
          `Using proxy: ${this.config.proxy.type}://${this.config.proxy.url.replace(/:[^:@]*@/, ':***@')}`,
        );
      }

      // Resolve a stable WA-Web build instead of keeping an old hard-coded page forever.
      // Exact operator pins remain supported; WWEBJS_WEB_VERSION=off opts out.
      const versionPin = await resolveWebVersionPin();
      if (this.tearingDown) {
        this.setStatus(EngineStatus.DISCONNECTED);
        return;
      }
      if (versionPin) {
        this.logger.log(`Pinning WhatsApp Web version ${versionPin.webVersion}`);
      }

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: this.config.sessionId,
          dataPath: path.resolve(this.config.sessionDataPath),
        }),
        puppeteer: {
          headless: this.config.puppeteer?.headless ?? true,
          args: puppeteerArgs,
          // Only override the executable when explicitly configured; otherwise let
          // whatsapp-web.js fall back to Puppeteer's bundled Chromium.
          ...(this.config.puppeteer?.executablePath ? { executablePath: this.config.puppeteer.executablePath } : {}),
        },
        ...(versionPin ?? {}),
      });

      this.setupEventHandlers();
      await this.client.initialize();
    } catch (error) {
      this.setStatus(EngineStatus.FAILED);
      const reason = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(reason);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('qr', async (qr: string) => {
      try {
        this.qrCode = await qrcode.toDataURL(qr);
        this.setStatus(EngineStatus.QR_READY);
        this.callbacks.onQRCode?.(this.qrCode);
      } catch (error) {
        this.logger.error('Error generating QR code', String(error));
      }
    });

    this.client.on('authenticated', () => {
      if (
        this.tearingDown ||
        this.status === EngineStatus.AUTHENTICATING ||
        this.status === EngineStatus.READY ||
        this.status === EngineStatus.FAILED
      ) {
        return;
      }
      this.setStatus(EngineStatus.AUTHENTICATING);
      this.qrCode = null;
      this.scheduleReadyReconcile();
    });

    this.client.on('ready', () => {
      // The patched client flips this marker only after the page-to-Node event bridge attaches.
      // A premature READY would otherwise expose empty chats/contacts and lose inbound messages.
      if ((this.client as Client & { eventsAttached?: boolean }).eventsAttached === false) {
        this.logger.warn('Ignoring premature ready because the WhatsApp message bridge is not attached', {
          sessionId: this.config.sessionId,
          action: 'premature_ready_ignored',
        });
        return;
      }
      this.markReadyFromClientInfo();
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('message', async msg => {
      try {
        const incomingMessage: IncomingMessage = buildIncomingMessageBase(msg);

        // Enrich the sender contact with the saved name (best-effort, from the WhatsApp Web cache).
        // `author`/`from` resolve to the actual sender for group and 1:1 messages respectively.
        try {
          const contact = await msg.getContact();
          if (contact?.name || contact?.pushname) {
            incomingMessage.contact = {
              name: contact.name || incomingMessage.contact?.name,
              pushName: contact.pushname || incomingMessage.contact?.pushName,
            };
          }
          const senderId = msg.author ?? msg.from;
          if (senderId.endsWith('@lid') && contact?.number) {
            this.rememberLidPhone(senderId, contact.number);
            const senderPhone = this.normalizePhone(contact.number);
            const lidDigits = senderId.split('@')[0].replace(/\D/g, '');
            if (senderPhone && senderPhone !== lidDigits) {
              incomingMessage.senderPhone = senderPhone;
            }
          }
        } catch (error) {
          this.logger.error('Error getting message contact', String(error));
        }

        // Handle location
        if (msg.type === MessageTypes.LOCATION && msg.location) {
          incomingMessage.location = {
            latitude: Number(msg.location.latitude),
            longitude: Number(msg.location.longitude),
            description: msg.location.description || undefined,
            address: msg.location.address || undefined,
            url: msg.location.url || undefined,
          };
        }

        // Handle media
        if (msg.hasMedia) {
          try {
            const media = await msg.downloadMedia();
            if (media) {
              incomingMessage.media = {
                mimetype: media.mimetype,
                filename: media.filename || undefined,
                data: media.data,
              };
            }
          } catch (error) {
            this.logger.error('Error downloading media', String(error));
          }
        }

        // Handle quoted message
        if (msg.hasQuotedMsg) {
          try {
            const quoted = await msg.getQuotedMessage();
            incomingMessage.quotedMessage = {
              id: quoted.id._serialized,
              body: quoted.body,
            };
          } catch (error) {
            this.logger.error('Error getting quoted message', String(error));
          }
        }

        this.callbacks.onMessage?.(incomingMessage);
      } catch (error) {
        this.logger.error('Error processing incoming message', String(error));
      }
    });

    this.client.on('message_create', msg => {
      // `message_create` fires for every message the account creates — including ones composed on a
      // linked phone, which the `message` event above never delivers. Incoming messages are already
      // handled there, so forward only the account's own outgoing (`fromMe`) messages; this is the
      // single source for `message.sent` (covers API sends and phone-composed self-messages alike).
      if (!msg.fromMe) {
        return;
      }

      try {
        this.callbacks.onMessageCreate?.(buildIncomingMessageBase(msg));
      } catch (error) {
        this.logger.error('Error processing outgoing message', String(error));
      }
    });

    this.client.on('message_ack', (msg, ack) => {
      // Map the whatsapp-web.js MessageAck integer to the neutral DeliveryStatus here, at the
      // adapter boundary, so no downstream consumer ever sees engine-specific ack codes.
      this.callbacks.onMessageAck?.(msg.id._serialized, wwebjsAckToDeliveryStatus(ack));
    });

    this.client.on('message_revoke_everyone', after => {
      try {
        const selfWid = this.client?.info?.wid?._serialized;
        // Emit structured data only; the engine layer never produces a localized
        // display string. The dashboard renders the localized "message deleted" text.
        const payload: RevokedMessage = {
          id: after.id._serialized,
          chatId: after.from === selfWid ? after.to : after.from,
          from: after.from,
          to: after.to,
          type: 'revoked',
          body: '',
          timestamp: after.timestamp,
        };
        this.callbacks.onMessageRevoked?.(payload);
      } catch (error) {
        this.logger.error('Error processing message_revoke_everyone', String(error));
      }
    });

    this.client.on('message_reaction', reaction => {
      try {
        const event: ReactionEvent = {
          messageId: reaction.msgId._serialized,
          chatId: reaction.id.remote,
          reaction: reaction.reaction,
          senderId: reaction.senderId,
        };
        this.callbacks.onMessageReaction?.(event);
      } catch (error) {
        this.logger.error('Error processing message_reaction', String(error));
      }
    });

    this.client.on('disconnected', reason => {
      this.clearReadyReconcile();
      this.setStatus(EngineStatus.DISCONNECTED);
      this.callbacks.onDisconnected?.(reason);
    });

    this.client.on('auth_failure', (message?: string) => {
      this.clearReadyReconcile();
      this.setStatus(EngineStatus.FAILED);
      // Authentication failure is terminal: the stored credentials are invalid and
      // reconnecting will not help — the operator must re-scan the QR code. Route it
      // through onError (FAILED, no reconnect) rather than onDisconnected (reconnect).
      this.callbacks.onError?.(message ? `Authentication failed: ${message}` : 'Authentication failed');
    });
  }

  private markReadyFromClientInfo(): void {
    if (
      this.tearingDown ||
      [EngineStatus.READY, EngineStatus.DISCONNECTED, EngineStatus.FAILED].includes(this.status)
    ) {
      return;
    }

    this.clearReadyReconcile();
    try {
      const info = this.client?.info;
      this.phoneNumber = info?.wid?.user || null;
      this.pushName = info?.pushname || null;
      this.setStatus(EngineStatus.READY);
      this.callbacks.onReady?.(this.phoneNumber || '', this.pushName || '');
    } catch (error) {
      this.logger.error('Error getting client info', String(error));
      this.setStatus(EngineStatus.READY);
      this.callbacks.onReady?.('', '');
    }
  }

  private scheduleReadyReconcile(): void {
    this.clearReadyReconcile();
    this.readyReconcileStartedAt = Date.now();

    const tick = (): void => {
      if (!this.client || this.status !== EngineStatus.AUTHENTICATING) {
        this.clearReadyReconcile();
        return;
      }

      if (Date.now() - this.readyReconcileStartedAt >= READY_RECONCILE_TIMEOUT_MS) {
        const bridgeDead =
          this.lastProbeStateConnected &&
          (this.client as Client & { eventsAttached?: boolean }).eventsAttached === false;
        const reason = bridgeDead
          ? 'WhatsApp Web connected, but its message bridge did not attach. The saved session was kept; restart the session to relaunch the browser.'
          : 'WhatsApp Web did not finish synchronizing within 90 seconds. Restart the session and check the selected WhatsApp Web build.';

        this.logger.error(reason, undefined, {
          sessionId: this.config.sessionId,
          action: bridgeDead ? 'ready_reconcile_bridge_dead' : 'ready_reconcile_timeout',
        });
        this.clearReadyReconcile();
        this.setStatus(EngineStatus.FAILED);
        this.callbacks.onError?.(reason);
        return;
      }

      // Schedule first so a hung getState() cannot leave the session waiting forever.
      this.readyReconcileTimer = setTimeout(tick, READY_RECONCILE_INTERVAL_MS);
      this.readyReconcileTimer.unref?.();

      if (this.readyReconcileProbeInFlight) return;
      this.readyReconcileProbeInFlight = true;

      void this.isClientRuntimeReady()
        .then(ready => {
          if (ready && this.client && this.status === EngineStatus.AUTHENTICATING) {
            this.logger.warn('WhatsApp Web ready event was missed; reconciling from runtime state', {
              sessionId: this.config.sessionId,
              action: 'ready_event_reconciled',
            });
            this.markReadyFromClientInfo();
          } else if (this.status === EngineStatus.AUTHENTICATING) {
            this.maybeReloadDeadBridge();
          }
        })
        .catch(error => this.logger.debug('Ready reconciliation probe failed', { error: String(error) }))
        .finally(() => {
          this.readyReconcileProbeInFlight = false;
        });
    };

    this.readyReconcileTimer = setTimeout(tick, READY_RECONCILE_INTERVAL_MS);
    this.readyReconcileTimer.unref?.();
  }

  private clearReadyReconcile(): void {
    if (this.readyReconcileTimer) {
      clearTimeout(this.readyReconcileTimer);
      this.readyReconcileTimer = null;
    }
    this.readyReconcileStartedAt = 0;
    this.readyReconcileProbeInFlight = false;
    this.lastProbeStateConnected = false;
    this.readyReconcileReloadAttempted = false;
  }

  private async isClientRuntimeReady(): Promise<boolean> {
    if (!this.client) return false;

    const connected = (await this.client.getState()) === WAState.CONNECTED;
    this.lastProbeStateConnected = connected;
    if (!connected || !this.client.info?.wid?.user) return false;

    if ((this.client as Client & { eventsAttached?: boolean }).eventsAttached === false) return false;

    const page = (this.client as unknown as { pupPage?: { evaluate: <T>(fn: () => T) => Promise<T> } }).pupPage;
    const hasRuntime = await page?.evaluate(
      () => typeof (window as unknown as { WWebJS?: unknown }).WWebJS !== 'undefined',
    );
    return hasRuntime === true;
  }

  private maybeReloadDeadBridge(): void {
    if (this.readyReconcileReloadAttempted || !this.client || !this.lastProbeStateConnected) return;
    if ((this.client as Client & { eventsAttached?: boolean }).eventsAttached !== false) return;
    if (Date.now() - this.readyReconcileStartedAt < READY_RECONCILE_BRIDGE_RELOAD_GRACE_MS) return;

    this.readyReconcileReloadAttempted = true;
    this.logger.warn('WhatsApp Web message bridge did not attach; reloading the page once to reinject', {
      sessionId: this.config.sessionId,
      action: 'event_bridge_reload',
    });

    const page = (this.client as unknown as { pupPage?: { reload?: () => Promise<unknown> } }).pupPage;
    void page?.reload?.()?.catch((error: unknown) =>
      this.logger.warn('WhatsApp event-bridge reload failed', {
        sessionId: this.config.sessionId,
        error: String(error),
      }),
    );
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.callbacks.onStateChanged?.(status);
    this.emit('stateChanged', status);
  }

  private beginClientTeardown(): Client | null {
    this.tearingDown = true;
    this.clearReadyReconcile();

    const client = this.client;
    if (client && this.status !== EngineStatus.DISCONNECTED) {
      this.setStatus(EngineStatus.DISCONNECTED);
    }

    return client;
  }

  private finishClientTeardown(client: Client): void {
    if (this.client === client) this.client = null;
    this.clearReadyReconcile();
  }

  async disconnect(): Promise<void> {
    const client = this.beginClientTeardown();
    if (!client) return;

    try {
      // Preserve LocalAuth data so a restart does not require another QR scan.
      await client.destroy();
    } catch (error) {
      this.logger.warn('Destroy client failed:', String(error));
    } finally {
      this.finishClientTeardown(client);
    }
  }

  async logout(): Promise<void> {
    const client = this.beginClientTeardown();
    if (!client) return;

    try {
      await client.logout();
    } catch (error) {
      this.logger.warn('Logout failed:', String(error));
      try {
        await client.destroy();
      } catch (destroyError) {
        this.logger.warn('Client destroy also failed during logout fallback', String(destroyError));
      }
    } finally {
      this.finishClientTeardown(client);
    }
  }

  async destroy(): Promise<void> {
    const client = this.beginClientTeardown();
    if (!client) return;

    try {
      await client.destroy();
    } finally {
      this.finishClientTeardown(client);
    }
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  /**
   * Request an 8-char pairing code so the user can link via "Link with phone number" instead of
   * scanning the QR. Must be called after the engine has started (the client is initialized and
   * waiting to link); whatsapp-web.js throws if called before it is ready or after authentication.
   */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.client) {
      throw new EngineNotReadyError();
    }
    return this.client.requestPairingCode(phoneNumber);
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  private normalizePhone(value: string): string {
    return value.replace(/@(?:c\.us|s\.whatsapp\.net)$/i, '').replace(/\D/g, '');
  }

  private rememberLidPhone(lid: string | undefined, phone: string | undefined): void {
    if (!lid?.endsWith('@lid') || !phone) return;
    const digits = this.normalizePhone(phone);
    const lidDigits = lid.split('@')[0].replace(/\D/g, '');
    if (!digits || digits === lidDigits) return;
    this.lidToPhone.set(lid, digits);
    this.resolvedSendIds.set(`${digits}@c.us`, lid);
  }

  /** Resolve phone-addressed chats to WhatsApp's current send id and cache confirmed answers. */
  private async resolveSendId(chatId: string): Promise<string> {
    if (!chatId.endsWith('@c.us')) return chatId;

    const cached = this.resolvedSendIds.get(chatId);
    if (cached) return cached;

    try {
      const wid = await this.getNumberId(chatId);
      if (wid) {
        this.resolvedSendIds.set(chatId, wid);
        this.rememberLidPhone(wid, chatId);
        return wid;
      }
    } catch {
      // A transient existence-probe failure must not block the first send attempt.
    }
    return chatId;
  }

  /**
   * Hydrate a LID through a verified phone mapping. This is used only after a direct LID send has
   * failed, so valid privacy ids stay on the fast path and no privacy-id digits are treated as a
   * callable number.
   */
  private async recoverLidSendId(chatId: string): Promise<string | null> {
    let phone = this.lidToPhone.get(chatId) ?? null;
    if (!phone) {
      try {
        phone = await this.resolveContactPhone(chatId);
      } catch {
        return null;
      }
    }
    if (!phone) return null;

    try {
      const canonical = await this.getNumberId(phone);
      return canonical || null;
    } catch {
      return null;
    }
  }

  /** Resolve, send, and retry once when WhatsApp reports a stale recipient route. */
  private async sendResolved<T>(chatId: string, send: (to: string) => Promise<T>): Promise<T> {
    const to = await this.resolveSendId(chatId);
    try {
      return await send(to);
    } catch (error) {
      const unresolvedPhone =
        chatId.endsWith('@c.us') && (isNoLidForUserError(error) || error instanceof UnresolvedWwebjsRecipientError);
      if (unresolvedPhone) {
        this.resolvedSendIds.delete(chatId);
        const fresh = await this.resolveSendId(chatId);
        if (fresh === to) throw new RecipientUnreachableError();
        this.logger.warn('Retrying send after WhatsApp refreshed the recipient LID', {
          chatId,
          staleId: to,
          freshId: fresh,
        });
        try {
          return await send(fresh);
        } catch (retryError) {
          if (isNoLidForUserError(retryError) || retryError instanceof UnresolvedWwebjsRecipientError) {
            throw new RecipientUnreachableError();
          }
          throw retryError;
        }
      }

      const unresolvedLid =
        chatId.endsWith('@lid') && (isNoLidForUserError(error) || error instanceof UnresolvedWwebjsRecipientError);
      if (!unresolvedLid) throw error;

      const fresh = await this.recoverLidSendId(chatId);
      if (!fresh) throw new RecipientUnreachableError();
      this.logger.warn('Retrying send after hydrating a LID through its verified phone mapping', {
        chatId,
        freshId: fresh,
      });
      try {
        return await send(fresh);
      } catch (retryError) {
        if (isNoLidForUserError(retryError) || retryError instanceof UnresolvedWwebjsRecipientError) {
          throw new RecipientUnreachableError();
        }
        throw retryError;
      }
    }
  }

  private async sendClientMessage(
    chatId: string,
    send: (to: string) => Promise<WwebjsMessage | undefined>,
  ): Promise<WwebjsMessage> {
    return this.sendResolved(chatId, async to => {
      const message = await send(to);
      if (!message) throw new UnresolvedWwebjsRecipientError(to);
      return message;
    });
  }

  async sendTextMessage(chatId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    const msg = await this.sendClientMessage(chatId, to => this.client!.sendMessage(to, text));
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  private async sendMediaMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();

    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        // URL
        messageMedia = await loadRemoteMedia(media.data);
      } else {
        // Base64
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      // Buffer
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    const msg = await this.sendClientMessage(chatId, to =>
      this.client!.sendMessage(to, messageMedia, {
        caption: media.caption,
      }),
    );

    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async getContacts(): Promise<Contact[]> {
    this.ensureReady();
    const contacts = await this.client!.getContacts();

    return contacts.map(c => ({
      id: c.id._serialized,
      name: c.name || undefined,
      pushName: c.pushname || undefined,
      number: c.number,
      isMyContact: c.isMyContact,
      isBlocked: c.isBlocked,
    }));
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    this.ensureReady();
    try {
      const contact = await this.client!.getContactById(contactId);
      return {
        id: contact.id._serialized,
        name: contact.name || undefined,
        pushName: contact.pushname || undefined,
        number: contact.number,
        isMyContact: contact.isMyContact,
        isBlocked: contact.isBlocked,
      };
    } catch (error) {
      this.logger.warn(`Failed to get contact: ${contactId}`, String(error));
      return null;
    }
  }

  async getNumberId(number: string): Promise<string | null> {
    this.ensureReady();
    const numberId = await this.client!.getNumberId(number);
    const serialized = numberId?._serialized ?? null;
    if (serialized?.endsWith('@lid')) {
      this.rememberLidPhone(serialized, number);
    }
    return serialized;
  }

  async checkNumberExists(number: string): Promise<boolean> {
    return (await this.getNumberId(number)) !== null;
  }

  async resolveContactPhone(contactId: string): Promise<string | null> {
    this.ensureReady();
    const cached = this.lidToPhone.get(contactId);
    if (cached) return cached;

    let lookupError: unknown;
    try {
      // Query one id at a time: the batch form is prone to evaluation failures/rate-limiting.
      const [result] = await this.client!.getContactLidAndPhone([contactId]);
      const phone = result?.pn ? this.normalizePhone(result.pn) || null : null;
      if (phone) {
        this.rememberLidPhone(result?.lid || (contactId.endsWith('@lid') ? contactId : undefined), phone);
        return phone;
      }
    } catch (error) {
      lookupError = error;
    }

    // Recent WhatsApp builds can have the contact hydrated locally even when the explicit
    // LID/phone query returns an empty result. Reuse that loaded contact before touching internals.
    try {
      const contact = await this.client!.getContactById(contactId);
      const phone = this.validPhoneForLid(contactId, contact?.number);
      if (phone) {
        this.rememberLidPhone(contactId, phone);
        return phone;
      }
    } catch {
      // Continue to the runtime alternate-WID lookup.
    }

    const runtimePhone = await this.resolveContactPhoneFromRuntime(contactId).catch(() => null);
    if (runtimePhone) {
      this.rememberLidPhone(contactId, runtimePhone);
      return runtimePhone;
    }

    // Preserve transient failures so callers retry rather than caching a false missing mapping.
    if (lookupError instanceof Error) throw lookupError;
    if (lookupError) throw new Error('WhatsApp contact lookup failed');
    return null;
  }

  private validPhoneForLid(contactId: string, candidate?: string | null): string | null {
    const phone = candidate ? this.normalizePhone(candidate) : '';
    const lidDigits = contactId.endsWith('@lid') ? contactId.split('@')[0].replace(/\D/g, '') : '';
    return phone && phone !== lidDigits ? phone : null;
  }

  private async resolveContactPhoneFromRuntime(contactId: string): Promise<string | null> {
    const page = (
      this.client as unknown as {
        pupPage?: { evaluate: <T>(callback: (id: string) => T, id: string) => Promise<T> };
      }
    )?.pupPage;
    if (!page) return null;

    const serialized = await page.evaluate((id: string) => {
      try {
        const runtime = window as unknown as WwebjsRuntimeWindow;
        const widFactory = runtime.require('WAWebWidFactory') as {
          createWid(value: string): RuntimeWid;
        };
        const contactApi = runtime.require('WAWebApiContact') as {
          getPhoneNumber(wid: RuntimeWid): RuntimeWid | null | undefined;
          getAlternateUserWid(wid: RuntimeWid): RuntimeWid | null | undefined;
        };
        const wid = widFactory.createWid(id);
        const phone = contactApi.getPhoneNumber(wid) ?? contactApi.getAlternateUserWid(wid);
        if (!phone) return null;
        return phone._serialized ?? (phone.user && phone.server ? `${phone.user}@${phone.server}` : null);
      } catch {
        return null;
      }
    }, contactId);

    return this.validPhoneForLid(contactId, serialized);
  }

  async getGroups(): Promise<Group[]> {
    this.ensureReady();
    const chats = await this.client!.getChats();

    // Filter only group chats
    const groups = chats.filter(chat => chat.isGroup);

    // List path: read linkedParentJID synchronously from whatever metadata getChats()
    // already loaded. We deliberately do NOT fall back to getChatById per group here —
    // that would be an N+1 round-trip across every group on every list call. Groups
    // whose metadata isn't loaded report null; the single-group endpoint (getGroupInfo,
    // which loads full metadata via getChatById) is the authoritative source.
    return groups.map(g => {
      const groupChat = g as unknown as GroupChat;
      return {
        id: g.id._serialized,
        name: g.name,
        participantsCount: groupChat.participants?.length,
        isAdmin: groupChat.participants?.some(
          p => p.isAdmin && p.id._serialized === this.client?.info?.wid?._serialized,
        ),
        linkedParentJID: extractLinkedParentJID(groupChat.groupMetadata),
      };
    });
  }

  // ============= Phase 3: Extended Messaging =============

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.ensureReady();
    // Import Location class dynamically from whatsapp-web.js
    const module = await import('whatsapp-web.js');
    const Location = module.Location || module.default?.Location;

    const loc = new Location(location.latitude, location.longitude, {
      name: location.description || '',
      address: location.address || '',
    });
    const msg = await this.sendClientMessage(chatId, to => this.client!.sendMessage(to, loc));
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.ensureReady();
    // Create vCard format
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${contact.name}`,
      `TEL;type=CELL;type=VOICE;waid=${contact.number}:+${contact.number}`,
      'END:VCARD',
    ].join('\n');

    const msg = await this.sendClientMessage(chatId, to =>
      this.client!.sendMessage(to, vcard, {
        parseVCards: true,
      }),
    );
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        messageMedia = await loadRemoteMedia(media.data);
      } else {
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    const msg = await this.sendClientMessage(chatId, to =>
      this.client!.sendMessage(to, messageMedia, {
        sendMediaAsSticker: true,
      }),
    );
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    // Find the message to quote
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const quotedMsg = messages.find(m => m.id._serialized === quotedMsgId);

    if (!quotedMsg) {
      throw new Error(`Message ${quotedMsgId} not found`);
    }

    const msg = await this.sendClientMessage(chatId, to => quotedMsg.reply(text, to));
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReady();
    const chat = await this.client!.getChatById(fromChatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const msgToForward = messages.find(m => m.id._serialized === messageId);

    if (!msgToForward) {
      throw new Error(`Message ${messageId} not found`);
    }

    await this.sendResolved(toChatId, to => msgToForward.forward(to));
    // forward() returns void, so we generate a result based on original message
    return {
      id: `fwd_${messageId}`,
      timestamp: Date.now(),
    };
  }

  // ============= Phase 3: Group Management =============

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(groupId);
      if (!chat.isGroup) {
        return null;
      }
      const groupChat = chat as unknown as GroupChat;
      const participants: GroupParticipant[] = (groupChat.participants || []).map(p => ({
        id: String(p.id._serialized),
        number: String(p.id.user),
        name: p.name ? String(p.name) : undefined,
        isAdmin: Boolean(p.isAdmin),
        isSuperAdmin: Boolean(p.isSuperAdmin),
      }));

      return {
        id: chat.id._serialized,
        name: chat.name,
        description: groupChat.description ? String(groupChat.description) : undefined,
        owner: groupChat.owner?._serialized ? String(groupChat.owner._serialized) : undefined,
        createdAt: groupChat.createdAt,
        participants,
        isReadOnly: Boolean(groupChat.isReadOnly),
        isAnnounce: Boolean(groupChat.isAnnounce),
        linkedParentJID: extractLinkedParentJID(groupChat.groupMetadata),
      };
    } catch (error) {
      this.logger.warn(`Failed to get group: ${groupId}`, String(error));
      return null;
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.ensureReady();
    // Ensure participant IDs are in correct format
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    const result = await this.client!.createGroup(name, participantIds);

    const groupId = String((result as unknown as GroupCreateResult).gid._serialized);
    return {
      id: groupId,
      name: name,
      participantsCount: participants.length,
    };
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).addParticipants(participantIds);
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).removeParticipants(participantIds);
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).promoteParticipants(participantIds);
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).demoteParticipants(participantIds);
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).leave();
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setSubject(subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setDescription(description);
  }

  // Reactions (Phase 3)
  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    await (message as MessageWithReactions).react(emoji);
    this.logger.log(`Reacted to message ${messageId} with ${emoji || '(removed)'}`);
  }

  async getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    const msgWithReactions = message as MessageWithReactions;
    if (!msgWithReactions.hasReaction) {
      return [];
    }
    const reactions = await msgWithReactions.getReactions();
    if (!reactions) {
      return [];
    }
    // Map reactions to our interface format
    const result: MessageReaction[] = [];

    for (const r of reactions) {
      result.push({
        emoji: String(r.id),
        senders: (r.senders || []).map(s => ({
          senderId: String(s.senderId),
          emoji: String(s.reaction),
          timestamp: Number(s.timestamp),
        })),
      });
    }
    return result;
  }

  // Labels (Phase 3) - WhatsApp Business only
  async getLabels(): Promise<Label[]> {
    this.ensureReady();
    const labels = await (this.client as unknown as BusinessClient).getLabels();
    if (!labels) {
      return [];
    }

    return labels.map(label => ({
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    }));
  }

  async getLabelById(labelId: string): Promise<Label | null> {
    this.ensureReady();
    const label = await (this.client as unknown as BusinessClient).getLabelById(labelId);
    if (!label) {
      return null;
    }
    return {
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    };
  }

  async getChatLabels(chatId: string): Promise<Label[]> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const labels = await (chat as unknown as GroupChat).getLabels();
    if (!labels) {
      return [];
    }

    return labels.map(label => ({
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    }));
  }

  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    await (chat as unknown as GroupChat).addLabel(labelId);
    this.logger.log(`Added label ${labelId} to chat ${chatId}`);
  }

  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    await (chat as unknown as GroupChat).removeLabel(labelId);
    this.logger.log(`Removed label ${labelId} from chat ${chatId}`);
  }

  // Channels/Newsletter (Phase 3)
  async getSubscribedChannels(): Promise<Channel[]> {
    this.ensureReady();
    const channels = await (this.client as unknown as BusinessClient).getChannels();
    if (!channels) {
      return [];
    }
    return channels.map((ch: WwjsChannelData) => ({
      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
      name: String(ch.name || ''),
      description: ch.description ? String(ch.description) : undefined,
      inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,
      subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,
      verified: ch.verified ? Boolean(ch.verified) : undefined,
    }));
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    this.ensureReady();
    try {
      const ch = await (this.client as unknown as BusinessClient).getChannelById(channelId);
      if (!ch) {
        return null;
      }
      return {
        id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
        name: String(ch.name || ''),
        description: ch.description ? String(ch.description) : undefined,
        inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,
        subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,
        verified: ch.verified ? Boolean(ch.verified) : undefined,
      };
    } catch (error) {
      this.logger.warn(`Failed to get channel: ${channelId}`, String(error));
      return null;
    }
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    this.ensureReady();
    const ch = await (this.client as unknown as BusinessClient).subscribeToChannel(inviteCode);
    this.logger.log(`Subscribed to channel with invite code: ${inviteCode}`);
    return {
      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
      name: String(ch.name || ''),
      description: ch.description ? String(ch.description) : undefined,
    };
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    this.ensureReady();
    await (this.client as unknown as BusinessClient).unsubscribeFromChannel(channelId);
    this.logger.log(`Unsubscribed from channel: ${channelId}`);
  }

  async getChannelMessages(channelId: string, limit: number = 50): Promise<ChannelMessage[]> {
    this.ensureReady();
    try {
      const ch = await (this.client as unknown as BusinessClient).getChannelById(channelId);
      if (!ch) {
        throw new Error(`Channel ${channelId} not found`);
      }
      const messages = await ch.fetchMessages({ limit });
      if (!messages) {
        return [];
      }
      return messages.map(msg => ({
        id: String(typeof msg.id === 'object' ? msg.id._serialized : msg.id),
        body: String(msg.body || ''),
        timestamp: Number(msg.timestamp),
        hasMedia: Boolean(msg.hasMedia),
        mediaUrl: msg.mediaUrl ? String(msg.mediaUrl) : undefined,
      }));
    } catch (error) {
      this.logger.error(`Failed to get channel messages: ${String(error)}`);
      return [];
    }
  }

  // ========== Gap Quick Wins Implementation ==========

  async getChatHistory(chatId: string, limit: number = 50, includeMedia: boolean = false): Promise<IncomingMessage[]> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });
    const results: IncomingMessage[] = [];
    for (const msg of messages) {
      // Reuse the shared mapper so history messages carry the same author/contact
      // enrichment as live incoming messages (#223). The mapper defaults chatId to
      // msg.from, which is wrong here (history includes fromMe messages whose `from`
      // is our own number), so override it to the requested chat and recompute the
      // chatId-derived flags (isGroup, isStatusBroadcast) from the real chat.
      const out = buildIncomingMessageBase(msg);
      out.chatId = chatId;
      out.isGroup = chatId.endsWith('@g.us');
      out.isStatusBroadcast = chatId === 'status@broadcast';
      if (includeMedia && msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media) {
            out.media = {
              mimetype: media.mimetype,
              filename: media.filename || undefined,
              data: media.data,
            };
          }
        } catch (error) {
          this.logger.warn(`Failed to download media for ${msg.id._serialized}: ${String(error)}`);
        }
      }
      results.push(out);
    }
    return results;
  }

  // Delete Message
  async deleteMessage(chatId: string, messageId: string, forEveryone: boolean = true): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    await message.delete(forEveryone);
    this.logger.log(`Deleted message ${messageId} from chat ${chatId} (forEveryone: ${forEveryone})`);
  }

  // Get Profile Picture
  async getProfilePicture(contactId: string): Promise<string | null> {
    this.ensureReady();
    try {
      const url = await this.client!.getProfilePicUrl(contactId);
      return url || null;
    } catch (error) {
      this.logger.warn(`Failed to get profile picture for ${contactId}: ${String(error)}`);
      return null;
    }
  }

  // Block Contact
  async blockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const contact = await this.client!.getContactById(contactId);
    await contact.block();
    this.logger.log(`Blocked contact ${contactId}`);
  }

  // Unblock Contact
  async unblockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const contact = await this.client!.getContactById(contactId);
    await contact.unblock();
    this.logger.log(`Unblocked contact ${contactId}`);
  }

  // Get Group Invite Code
  async getGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const inviteCode = await (chat as unknown as GroupChat).getInviteCode();
    this.logger.log(`Got invite code for group ${groupId}`);
    return String(inviteCode);
  }

  // Revoke Group Invite Code
  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const newCode = await (chat as unknown as GroupChat).revokeInvite();
    this.logger.log(`Revoked invite code for group ${groupId}, new code generated`);
    return String(newCode);
  }

  // ========== Status/Stories (Phase 3) ==========
  // Note: These are stub implementations - whatsapp-web.js has limited Status API support
  /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

  async getContactStatuses(): Promise<Status[]> {
    this.ensureReady();
    // whatsapp-web.js has limited Status API support
    // This is a stub that can be enhanced when the library adds support
    this.logger.warn('getContactStatuses not fully implemented in whatsapp-web.js');
    return [];
  }

  async getContactStatus(_contactId: string): Promise<Status[]> {
    this.ensureReady();
    this.logger.warn('getContactStatus not fully implemented in whatsapp-web.js');
    return [];
  }

  async postTextStatus(_text: string, _options?: TextStatusOptions): Promise<StatusResult> {
    this.ensureReady();
    // whatsapp-web.js doesn't have native status posting
    // This would require using the underlying WhatsApp Web API directly
    throw new Error('postTextStatus not yet implemented in whatsapp-web.js adapter');
  }

  async postImageStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    this.ensureReady();
    throw new Error('postImageStatus not yet implemented in whatsapp-web.js adapter');
  }

  async postVideoStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    this.ensureReady();
    throw new Error('postVideoStatus not yet implemented in whatsapp-web.js adapter');
  }

  async deleteStatus(_statusId: string): Promise<void> {
    this.ensureReady();
    throw new Error('deleteStatus not yet implemented in whatsapp-web.js adapter');
  }

  // ========== Catalog (Phase 3) ==========

  async getCatalog(): Promise<Catalog | null> {
    this.ensureReady();
    // whatsapp-web.js doesn't have native Catalog API support
    this.logger.warn('getCatalog not implemented in whatsapp-web.js adapter');
    return null;
  }

  async getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    this.ensureReady();
    this.logger.warn('getProducts not implemented in whatsapp-web.js adapter');
    return {
      products: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    };
  }

  async getProduct(_productId: string): Promise<Product | null> {
    this.ensureReady();
    this.logger.warn('getProduct not implemented in whatsapp-web.js adapter');
    return null;
  }

  async sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    this.ensureReady();
    throw new Error('sendProduct not yet implemented in whatsapp-web.js adapter');
  }

  async sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    this.ensureReady();
    throw new Error('sendCatalog not yet implemented in whatsapp-web.js adapter');
  }

  /* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

  async getChats(): Promise<ChatSummary[]> {
    this.ensureReady();
    const chats = await this.client!.getChats();
    // Map the raw whatsapp-web.js chat objects to the library-agnostic ChatSummary
    // shape so that no library types leak past the engine boundary.
    return chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount,
      timestamp: chat.timestamp,
      lastMessage: chat.lastMessage?.body || undefined,
    }));
  }

  async sendSeen(chatId: string): Promise<boolean> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(chatId);
      return await chat.sendSeen();
    } catch (error) {
      this.logger.error(`Error marking chat ${chatId} as read`, String(error));
      return false;
    }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(chatId);
      return await chat.delete();
    } catch (error) {
      this.logger.error(`Error deleting chat ${chatId}`, String(error));
      return false;
    }
  }

  async sendChatState(chatId: string, state: ChatState): Promise<void> {
    this.ensureReady();
    try {
      const to = await this.resolveSendId(chatId);
      const chat = await this.client!.getChatById(to);
      if (state === 'typing') {
        await chat.sendStateTyping();
      } else if (state === 'recording') {
        await chat.sendStateRecording();
      } else {
        await chat.clearState();
      }
    } catch (error) {
      // Presence is best-effort — a failure here must never break the surrounding send.
      this.logger.warn(`Could not set chat state '${state}' for ${chatId} (best-effort)`, String(error));
    }
  }

  private ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.client) {
      // Typed so the global filter returns 409 Conflict ("session not connected")
      // instead of a 500 when an engine op is attempted while the session is
      // disconnected / reconnecting / still initializing (#100).
      throw new EngineNotReadyError();
    }
  }
}
