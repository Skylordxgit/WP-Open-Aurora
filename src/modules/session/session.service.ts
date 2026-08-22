import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  OnModuleDestroy,
  OnModuleInit,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, Not, IsNull, DataSource, MoreThan } from 'typeorm';
import { Session, SessionStatus } from './entities/session.entity';
import { ChatSnapshot } from './entities/chat-snapshot.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { SavedContact } from '../contact/entities/saved-contact.entity';
import { CreateSessionDto } from './dto';
import { EngineFactory } from '../../engine/engine.factory';
import {
  IWhatsAppEngine,
  EngineStatus,
  ChatSummary,
  ChatState,
  Contact,
  DeliveryStatus,
  IncomingMessage,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import {
  deliveryStatusToMessageStatus,
  deliveryStatusToAck,
  ackStatusTransitionFrom,
} from '../message/message-status.util';
import { MediaArchiveService } from '../../common/media/media-archive.service';

interface ReconnectState {
  attempts: number;
  timer: NodeJS.Timeout | null;
  maxAttempts: number;
  baseDelay: number;
  autoReconnect: boolean;
}

@Injectable()
export class SessionService implements OnModuleDestroy, OnModuleInit, OnApplicationBootstrap {
  private readonly logger = createLogger('SessionService');
  private static readonly CHAT_FETCH_TIMEOUT_MS = 15_000;
  private static readonly CHAT_FALLBACK_MESSAGE_SCAN = 5000;
  private static readonly CHAT_CACHE_TTL_MS = 5_000;
  private static readonly MAX_RECONNECT_DELAY_MS = 5 * 60_000;
  private static readonly DEFAULT_HISTORY_SYNC_LIMIT = 500;

  // In-memory map of active engine instances
  private engines: Map<string, IWhatsAppEngine> = new Map();
  // Bounded cache for inline @lid -> phone resolution (#263), keyed `${sessionId}:${lid}`. Caches
  // misses (null) too, so a chatty unmapped sender isn't re-queried on every message (which also
  // reduces engine rate-limit pressure). Best-effort feature, so staleness is acceptable.
  private readonly lidPhoneCache = new Map<string, string | null>();
  private static readonly LID_PHONE_CACHE_MAX = 5000;
  private readonly chatCache = new Map<string, { chats: ChatSummary[]; expiresAt: number }>();
  private readonly chatRefreshes = new Map<string, Promise<ChatSummary[]>>();
  private readonly archiveSyncs = new Map<string, Promise<void>>();
  private readonly messagePersistQueues = new Map<string, Promise<void>>();
  // Transient, human-readable reason for the most recent terminal engine failure,
  // keyed by session id. Surfaced on read so the dashboard can explain a FAILED
  // status; cleared when the session re-initializes or becomes ready.
  private sessionErrors: Map<string, string> = new Map();

  // Reconnection state per session
  private reconnectStates: Map<string, ReconnectState> = new Map();

  // Sessions currently being stopped/deleted. An in-flight executeReconnect awaits
  // engine init, so a stop/delete during that window could re-register an engine AFTER
  // teardown (orphan). stop()/delete() add the id here; executeReconnect checks it after its
  // awaits and destroys any engine it just created; start() clears it (intentional restart).
  private stoppingSessions: Set<string> = new Set();

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(SavedContact, 'data')
    private readonly savedContactRepository: Repository<SavedContact>,
    @InjectRepository(ChatSnapshot, 'data')
    private readonly chatSnapshotRepository: Repository<ChatSnapshot>,
    @InjectDataSource('data')
    private readonly dataSource: DataSource,
    private readonly engineFactory: EngineFactory,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookService: WebhookService,
    private readonly hookManager: HookManager,
    private readonly mediaArchiveService: MediaArchiveService,
  ) {}

  /**
   * On backend startup, reset all active session statuses to disconnected
   * because the engines are not running yet after restart
   */
  async onModuleInit(): Promise<void> {
    const activeStatuses = [
      SessionStatus.READY,
      SessionStatus.INITIALIZING,
      SessionStatus.QR_READY,
      SessionStatus.AUTHENTICATING,
    ];

    const result = await this.sessionRepository.update(
      { status: In(activeStatuses) },
      { status: SessionStatus.DISCONNECTED },
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(`Reset ${result.affected} session(s) to disconnected on startup`, {
        action: 'startup_reset',
        affected: result.affected,
      });
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.AUTO_START_SESSIONS !== 'true') return;

    const sessions = await this.sessionRepository.find({
      where: { phone: Not(IsNull()), status: SessionStatus.DISCONNECTED },
    });

    if (sessions.length === 0) return;

    this.logger.log(`Auto-starting ${sessions.length} previously authenticated session(s)`, {
      action: 'auto_start',
      count: sessions.length,
    });

    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      try {
        await this.start(session.id);
        this.logger.log(`Auto-started session: ${session.name}`, {
          sessionId: session.id,
          action: 'auto_start_success',
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Auto-start failed for session: ${session.name}`, errorMessage, {
          sessionId: session.id,
          action: 'auto_start_failed',
        });
      }
      // Throttle between sequential Chromium launches; no need to wait after the last one.
      if (i < sessions.length - 1) {
        await this.delay(2000);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Stop reconnect timers FIRST so nothing reschedules mid-teardown, and so this always runs even
    // if an engine.destroy() below hangs or throws.
    for (const [, state] of this.reconnectStates) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.reconnectStates.clear();

    // Destroy engines in parallel, each isolated + time-bounded, so one stuck Chromium can neither
    // stall the shutdown nor abort teardown of the other sessions.
    await Promise.allSettled(
      [...this.engines].map(([sessionId, engine]) => this.destroyEngineSafely(sessionId, engine)),
    );
    this.engines.clear();
  }

  /** Destroy one engine, isolating + time-bounding failures so shutdown can't be stalled or aborted. */
  private async destroyEngineSafely(sessionId: string, engine: IWhatsAppEngine): Promise<void> {
    this.logger.log(`Destroying engine for session ${sessionId}`, { sessionId, action: 'shutdown' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        engine.destroy(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('engine.destroy() timed out')), 10_000);
        }),
      ]);
    } catch (err) {
      this.logger.error(`Failed to destroy engine for session ${sessionId} during shutdown`, String(err), {
        sessionId,
        action: 'shutdown_destroy_failed',
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async create(dto: CreateSessionDto): Promise<Session> {
    // Check if session with same name exists
    const existing = await this.sessionRepository.findOne({
      where: { name: dto.name },
    });

    if (existing) {
      throw new ConflictException(`Session with name '${dto.name}' already exists`);
    }

    const session = this.sessionRepository.create({
      name: dto.name,
      config: dto.config || {},
      proxyUrl: dto.proxyUrl || null,
      proxyType: dto.proxyType || null,
      status: SessionStatus.CREATED,
    });

    const saved = await this.dataSource.transaction(async manager => {
      return await manager.save(session);
    });
    this.logger.log(`Session created: ${saved.name}`, {
      sessionId: saved.id,
      action: 'create',
    });

    // Execute hook after session created (outside transaction since hooks do external I/O)
    await this.hookManager.execute('session:created', saved, {
      sessionId: saved.id,
      source: 'SessionService',
    });

    return saved;
  }

  async findAll(): Promise<Session[]> {
    const sessions = await this.sessionRepository.find({
      order: { createdAt: 'DESC' },
    });
    return sessions.map(session => this.attachLastError(session));
  }

  async findOne(id: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException(`Session with id '${id}' not found`);
    }
    return this.attachLastError(session);
  }

  /**
   * Populate the transient `lastError` field from the in-memory error map. Only a
   * FAILED session carries an error; any other status clears it so a recovered
   * session never shows a stale failure reason.
   */
  private attachLastError(session: Session): Session {
    session.lastError = session.status === SessionStatus.FAILED ? this.sessionErrors.get(session.id) : undefined;
    return session;
  }

  async findByName(name: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { name } });
    if (!session) {
      throw new NotFoundException(`Session with name '${name}' not found`);
    }
    return session;
  }

  async delete(id: string): Promise<void> {
    const session = await this.findOne(id);

    // Mark as tearing down BEFORE cleanup so an in-flight reconnect can't resurrect it.
    this.stoppingSessions.add(id);
    // Cancel any reconnection attempts
    this.cancelReconnect(id);

    // Stop engine if running
    const engine = this.engines.get(id);
    if (engine) {
      await engine.destroy();
      this.engines.delete(id);
    }

    // Execute hook BEFORE delete so plugins can access session data
    await this.hookManager.execute(
      'session:deleted',
      {
        id: session.id,
        name: session.name,
        phone: session.phone,
        pushName: session.pushName,
      },
      {
        sessionId: id,
        source: 'SessionService',
      },
    );

    await this.dataSource.transaction(async manager => {
      await manager.remove(session);
    });
    this.logger.log(`Session deleted: ${session.name}`, {
      sessionId: id,
      action: 'delete',
    });
  }

  async start(id: string): Promise<Session> {
    const session = await this.findOne(id);

    if (this.engines.has(id)) {
      throw new BadRequestException('Session is already started');
    }

    // A fresh start intentionally (re-)creates the engine — clear any stale stop/delete mark.
    this.stoppingSessions.delete(id);

    // Execute hook before starting
    await this.hookManager.execute(
      'session:starting',
      { sessionId: id },
      {
        sessionId: id,
        source: 'SessionService',
      },
    );

    // Initialize reconnect state
    const config = session.config as {
      maxReconnectAttempts?: number;
      reconnectBaseDelay?: number;
      autoReconnect?: boolean;
    } | null;
    const envMaxAttempts = Number(
      process.env.SESSION_MAX_RECONNECT_ATTEMPTS ?? process.env.WA_MAX_RECONNECT_ATTEMPTS ?? 0,
    );
    const configuredMaxAttempts = config?.maxReconnectAttempts ?? envMaxAttempts;
    const configuredBaseDelay =
      config?.reconnectBaseDelay ??
      Number(process.env.SESSION_RECONNECT_BASE_DELAY ?? process.env.WA_RECONNECT_INTERVAL ?? 5000);
    this.reconnectStates.set(id, {
      attempts: 0,
      timer: null,
      // A value <= 0 means unlimited retries. Explicit positive per-session limits remain supported.
      maxAttempts:
        Number.isFinite(configuredMaxAttempts) && configuredMaxAttempts > 0
          ? Math.trunc(configuredMaxAttempts)
          : Number.POSITIVE_INFINITY,
      baseDelay:
        Number.isFinite(configuredBaseDelay) && configuredBaseDelay > 0
          ? Math.max(Math.trunc(configuredBaseDelay), 1000)
          : 5000,
      autoReconnect: config?.autoReconnect !== false,
    });

    try {
      await this.initializeEngine(id, session);
    } catch (error) {
      await this.cleanupFailedEngine(id);
      throw error;
    }
    return this.findOne(id);
  }

  private async initializeEngine(id: string, session: Session): Promise<void> {
    this.logger.log(`Initializing engine for session: ${session.name}`, {
      sessionId: id,
      action: 'engine_init',
      proxyEnabled: !!session.proxyUrl,
    });

    const engine = this.engineFactory.create({
      sessionId: session.name,
      proxyUrl: session.proxyUrl || undefined,
      proxyType: session.proxyType || undefined,
    });
    this.engines.set(id, engine);
    const isCurrentEngine = (): boolean => this.isCurrentEngine(id, engine);
    // Clear any prior failure reason before a fresh start.
    this.sessionErrors.delete(id);

    // Mark INITIALIZING before engine.initialize(): the engine drives status forward
    // (QR_READY -> AUTHENTICATING -> READY) through the callbacks below while it
    // initializes, so writing INITIALIZING afterwards would clobber that progress.
    await this.updateStatus(id, SessionStatus.INITIALIZING);

    await engine.initialize({
      onQRCode: (): void => {
        if (!isCurrentEngine()) return;
        this.logger.log('QR code generated', {
          sessionId: id,
          action: 'qr_generated',
        });

        // Execute hook for QR event
        void this.hookManager.execute(
          'session:qr',
          { sessionId: id },
          {
            sessionId: id,
            source: 'Engine',
          },
        );

        void this.updateStatus(id, SessionStatus.QR_READY);
      },
      onReady: (phone: string, pushName: string): void => {
        if (!isCurrentEngine()) return;
        // Evolution's status endpoint does not expose its private myJid field. Preserve Aurora's
        // last known identity when a warm reattach reports readiness before a Connected event.
        const resolvedPhone = phone || session.phone || '';
        const resolvedPushName = pushName || session.pushName || '';
        this.logger.log(`Session ready: ${resolvedPhone}`, {
          sessionId: id,
          phone: resolvedPhone,
          pushName: resolvedPushName,
          action: 'ready',
        });

        // Execute hook for ready event
        void this.hookManager.execute(
          'session:ready',
          { phone: resolvedPhone, pushName: resolvedPushName },
          {
            sessionId: id,
            source: 'Engine',
          },
        );

        // Reset reconnect attempts and clear any stale failure reason on success
        const reconnectState = this.reconnectStates.get(id);
        if (reconnectState) {
          if (reconnectState.timer) {
            clearTimeout(reconnectState.timer);
            reconnectState.timer = null;
          }
          reconnectState.attempts = 0;
        }
        this.sessionErrors.delete(id);

        void this.sessionRepository
          .update(id, {
            status: SessionStatus.READY,
            phone: resolvedPhone,
            pushName: resolvedPushName,
            connectedAt: new Date(),
            lastActiveAt: new Date(),
          })
          .then(() => {
            if (isCurrentEngine()) return this.startArchiveSync(id, engine);
            return undefined;
          })
          .catch(error => {
            this.logger.error(`Failed to finalize ready session ${id}`, String(error));
          });
      },
      onMessage: (message): void => {
        if (!isCurrentEngine()) return;
        // Status/Story posts arrive via the inbound path for some engines; don't persist or webhook them.
        // Mirrors the isStatusBroadcast guard in onMessageCreate below.
        if (message.isStatusBroadcast) {
          return;
        }
        this.logger.debug(`Message received from ${message.from}`, {
          sessionId: id,
          messageId: message.id,
          from: message.from,
          action: 'message_received',
        });
        // Update last active timestamp
        void this.sessionRepository.update(id, { lastActiveAt: new Date() });
        // Convert IncomingMessage to plain object for dispatch
        const messageData = { ...message };

        // Execute hook for message received - plugins can modify or stop processing
        void this.hookManager
          .execute('message:received', messageData, {
            sessionId: id,
            source: 'Engine',
          })
          .then(async ({ continue: shouldContinue, data: finalMessage }) => {
            if (!shouldContinue || !isCurrentEngine()) {
              // Plugin stopped processing (e.g., auto-reply handled it)
              return;
            }

            // Persist the incoming message so the dashboard chats view can render history.
            const incoming: IncomingMessage = finalMessage;

            // Inline @lid -> phone resolution (#263), opt-in via RESOLVE_LID_TO_PHONE. Best-effort:
            // attaches senderPhone (digits or null) before persist/dispatch so webhook/ws consumers
            // get it in a single pass. Only for privacy-id senders, so no lookup for normal numbers.
            if (process.env.RESOLVE_LID_TO_PHONE === 'true' && incoming.isLidSender && !incoming.fromMe) {
              incoming.senderPhone = await this.resolveSenderPhone(id, incoming.author ?? incoming.from);
            }

            // Commit first, then publish. A browser refresh or websocket reconnect can now always
            // reconstruct the same message from the database.
            await this.persistMessages(id, [incoming], undefined, true);

            if (!isCurrentEngine()) return;

            // Dispatch to webhooks with potentially modified message
            void this.webhookService.dispatch(id, 'message.received', finalMessage);
            // Emit real-time event to WebSocket clients
            this.eventsGateway.emitMessage(id, finalMessage);
          })
          .catch(err => this.logger.error(`onMessage handler failed for ${id}`, String(err)));
      },
      onMessageCreate: (message): void => {
        if (!isCurrentEngine()) return;
        // `message_create` fires for every message the account creates, including sends composed on a
        // linked phone — which the `message`/`onMessage` event never delivers. Incoming messages are
        // already handled by `onMessage`, so only outgoing (`fromMe`) ones produce `message.sent` here.
        if (!message.fromMe) {
          return;
        }

        // Status/Story posts are account-created but not real conversations; don't emit `message.sent`
        // for them. The adapter flags these (the engine-specific pseudo-JID stays out of this layer).
        if (message.isStatusBroadcast) {
          return;
        }

        this.logger.debug(`Message sent to ${message.to}`, {
          sessionId: id,
          messageId: message.id,
          to: message.to,
          action: 'message_sent',
        });
        // Update last active timestamp
        void this.sessionRepository.update(id, { lastActiveAt: new Date() });
        const messageData = { ...message };

        // Execute hook for message sent - plugins can modify or stop processing
        void this.hookManager
          .execute('message:sent', messageData, {
            sessionId: id,
            source: 'Engine',
          })
          .then(({ continue: shouldContinue, data: finalMessage }) => {
            if (!shouldContinue || !isCurrentEngine()) {
              return;
            }

            // Messages composed on the linked phone do not pass through MessageService, so persist
            // them here as well. API sends are matched to their pending row to avoid duplicates.
            void this.persistOutgoingEngineMessage(id, finalMessage);

            // Dispatch to webhooks with potentially modified message
            void this.webhookService.dispatch(id, 'message.sent', finalMessage);
            // Emit real-time event to WebSocket clients (as message.sent, not message.received)
            this.eventsGateway.emitMessageSent(id, finalMessage);
          })
          .catch(err => this.logger.error(`onMessageCreate handler failed for ${id}`, String(err)));
      },
      onMessageAck: (messageId, status: DeliveryStatus): void => {
        if (!isCurrentEngine()) return;
        this.logger.debug(`Message ack: ${messageId} -> ${status}`, {
          sessionId: id,
          messageId,
          status,
          action: 'message_ack',
        });

        // Reflect real delivery state on the stored message (#220): delivered/read/failed advance the
        // stored status; pending/sent carry no upgrade (it's already SENT — visibly "not delivered").
        // The UPDATE is guarded to the allowed prior statuses so delivery state only ADVANCES: an
        // out-of-order/late ack cannot downgrade a higher status, which also makes these
        // fire-and-forget writes race-safe at the DB level.
        const messageStatus = deliveryStatusToMessageStatus(status);
        if (messageStatus) {
          void this.messageRepository
            // Scope by sessionId: waMessageId is unique per account/chat, not global —
            // an ack on one session must never advance a same-id row in another session.
            .update(
              { sessionId: id, waMessageId: messageId, status: In(ackStatusTransitionFrom(messageStatus)) },
              { status: messageStatus },
            )
            .then(result => {
              // affected:0 — the row was not advanced: either the send's 2nd save (which sets
              // waMessageId) hasn't committed yet, or the status is already at/above the target.
              if (result.affected === 0) {
                this.logger.debug(`Message ack ${messageId}: no status row advanced to ${messageStatus} (${status})`, {
                  sessionId: id,
                  messageId,
                  status,
                  action: 'message_ack_noop',
                });
              }
            });
        }

        // Push the live delivery/read tick to the dashboard over the websocket (neutral status).
        this.eventsGateway.emitMessageAck(id, { messageId, status });

        // Dispatch the delivery/read receipt to webhooks (#155). Outgoing `message.sent` is handled
        // solely by `onMessageCreate`, so the ack path deliberately does NOT emit `message.sent`.
        // `id` mirrors the field every other message.* webhook carries (and the idempotency key
        // resolver reads). `ack` is a deprecated legacy field kept for backward compatibility —
        // new consumers should read the neutral `status`.
        void this.webhookService.dispatch(id, 'message.ack', {
          id: messageId,
          messageId,
          status,
          ack: deliveryStatusToAck(status),
        });

        // Surface delivery failures actively so consumers don't have to poll for them (#220).
        if (status === 'failed') {
          void this.webhookService.dispatch(id, 'message.failed', {
            id: messageId,
            messageId,
            status,
            ack: deliveryStatusToAck(status),
          });
        }
      },
      onMessageRevoked: (message): void => {
        if (!isCurrentEngine()) return;
        this.logger.debug(`Message revoked: ${message.id}`, {
          sessionId: id,
          messageId: message.id,
          action: 'message_revoked',
        });

        // Flag the stored message as revoked (best-effort; the message may not be in the
        // DB). The dashboard renders the localized "message deleted" text, so no display
        // string is persisted here.
        void this.messageRepository
          .update({ sessionId: id, waMessageId: message.id }, { body: '', type: 'revoked' })
          .catch(err => {
            this.logger.error(`Failed to update revoked message: ${message.id}`, String(err));
          });

        // Notify consumers regardless of whether the row existed: webhook (message.revoked
        // is a declared event) + the real-time dashboard stream.
        const revokedPayload = message as unknown as Record<string, unknown>;
        void this.webhookService.dispatch(id, 'message.revoked', revokedPayload);
        this.eventsGateway.emitMessageRevoked(id, revokedPayload);
      },
      onMessageReaction: (event): void => {
        if (!isCurrentEngine()) return;
        if (!event.messageId) {
          this.logger.warn('Ignoring message reaction without a resolvable message id', {
            sessionId: id,
            action: 'message_reaction_ignored',
          });
          return;
        }

        this.logger.debug(`Message reaction received: ${event.messageId} -> ${event.reaction}`, {
          sessionId: id,
          messageId: event.messageId,
          action: 'message_reaction_received',
        });

        void this.messageRepository
          .findOne({ where: { sessionId: id, waMessageId: event.messageId } })
          .then(async msg => {
            if (!msg) return;
            const metadata = msg.metadata || {};
            const reactions = (metadata.reactions as Record<string, string>) || {};

            if (!event.reaction) {
              delete reactions[event.senderId];
            } else {
              reactions[event.senderId] = event.reaction;
            }

            metadata.reactions = reactions;
            msg.metadata = metadata;
            await this.messageRepository.save(msg);

            this.eventsGateway.emitMessageReaction(id, { ...event, reactions });
          })
          .catch(err => {
            this.logger.error(`Failed to update message reaction: ${event.messageId}`, String(err));
          });
      },
      onMessageEdited: (event): void => {
        if (!isCurrentEngine()) return;
        void this.messageRepository
          .findOne({ where: { sessionId: id, waMessageId: event.messageId } })
          .then(async message => {
            if (!message) return;
            message.body = event.body;
            message.type = event.type;
            message.metadata = {
              ...(message.metadata || {}),
              editedAt: new Date(event.timestamp * 1000).toISOString(),
            };
            await this.messageRepository.save(message);

            const payload = { ...event, id: event.messageId };
            this.eventsGateway.emitMessageEdited(id, payload);
            await this.webhookService.dispatch(id, 'message.edited', payload);
          })
          .catch(err => {
            this.logger.error(`Failed to persist message edit: ${event.messageId}`, String(err));
          });
      },
      onHistorySync: (messages): void => {
        if (!isCurrentEngine() || messages.length === 0) return;
        void this.persistHistory(id, messages).catch(error => {
          this.logger.error(`Failed to persist Evolution history sync for ${id}`, String(error));
        });
      },
      onContactsSync: (contacts): void => {
        if (!isCurrentEngine() || contacts.length === 0) return;
        void this.persistSessionContacts(id, contacts).catch(error => {
          this.logger.error(`Failed to persist Evolution contact sync for ${id}`, String(error));
        });
      },
      onDisconnected: (reason: string): void => {
        if (!isCurrentEngine()) {
          return;
        }

        this.logger.warn(`Session disconnected: ${reason}`, {
          sessionId: id,
          reason,
          action: 'disconnected',
        });

        // Execute hook for disconnected event
        void this.hookManager.execute(
          'session:disconnected',
          { reason },
          {
            sessionId: id,
            source: 'Engine',
          },
        );

        void this.updateStatus(id, SessionStatus.DISCONNECTED);

        // Attempt to reconnect
        this.scheduleReconnect(id, session);
      },
      onStateChanged: (engineState: EngineStatus): void => {
        if (!isCurrentEngine()) return;
        // FAILED is classified by onError below. Persisting it here as well can race a recoverable
        // error's DISCONNECTED write and leave a reconnecting session incorrectly marked terminal.
        if (engineState === EngineStatus.FAILED) return;
        const statusMap: Record<EngineStatus, SessionStatus> = {
          [EngineStatus.DISCONNECTED]: SessionStatus.DISCONNECTED,
          [EngineStatus.INITIALIZING]: SessionStatus.INITIALIZING,
          [EngineStatus.QR_READY]: SessionStatus.QR_READY,
          [EngineStatus.AUTHENTICATING]: SessionStatus.AUTHENTICATING,
          [EngineStatus.READY]: SessionStatus.READY,
          [EngineStatus.FAILED]: SessionStatus.FAILED,
        };
        const newStatus = statusMap[engineState];
        if (newStatus) {
          void this.updateStatus(id, newStatus);
        }
      },
      onError: (reason: string): void => {
        if (!isCurrentEngine()) return;
        this.logger.error(`Session engine failed: ${reason}`, undefined, {
          sessionId: id,
          reason,
          action: 'engine_error',
        });

        void this.hookManager.execute(
          'session:error',
          { reason },
          {
            sessionId: id,
            source: 'Engine',
          },
        );

        if (this.isTerminalAuthenticationError(reason)) {
          // Invalid/removed credentials require a new QR scan; retrying the same LocalAuth data
          // indefinitely cannot recover this state.
          this.sessionErrors.set(id, reason);
          void this.updateStatus(id, SessionStatus.FAILED);
          return;
        }

        // Browser, page bridge, and synchronization failures are recoverable. Preserve LocalAuth
        // and keep retrying instead of permanently suspending a previously linked session.
        this.sessionErrors.delete(id);
        void this.updateStatus(id, SessionStatus.DISCONNECTED);
        this.scheduleReconnect(id, session);
      },
    });
  }

  private isCurrentEngine(sessionId: string, engine: IWhatsAppEngine): boolean {
    return !this.stoppingSessions.has(sessionId) && this.engines.get(sessionId) === engine;
  }

  private async cleanupFailedEngine(id: string): Promise<void> {
    const failedEngine = this.engines.get(id);
    if (!failedEngine) return;
    this.engines.delete(id);
    await this.destroyEngineSafely(id, failedEngine);
  }

  private scheduleReconnect(id: string, session: Session): void {
    const state = this.reconnectStates.get(id);
    if (!state || !state.autoReconnect || state.timer || this.stoppingSessions.has(id)) return;

    if (state.attempts >= state.maxAttempts) {
      this.logger.error(`Max reconnect attempts reached for session: ${session.name}`, undefined, {
        sessionId: id,
        attempts: state.attempts,
        action: 'reconnect_failed',
      });
      // Don't leave the session silently stuck DISCONNECTED — mark it terminally FAILED with a reason
      // so findOne/findAll surface it via `lastError` and the dashboard shows it needs a restart.
      this.sessionErrors.set(id, `Reconnection failed after ${state.attempts} attempts — restart the session.`);
      void this.updateStatus(id, SessionStatus.FAILED);
      return;
    }

    // Exponential backoff: baseDelay * 2^attempts (with jitter)
    const exponentialDelay = state.baseDelay * Math.pow(2, Math.min(state.attempts, 16));
    const delay = Math.min(exponentialDelay, SessionService.MAX_RECONNECT_DELAY_MS) + Math.random() * 1000;
    state.attempts++;

    const attemptLabel = Number.isFinite(state.maxAttempts)
      ? `${state.attempts}/${state.maxAttempts}`
      : `${state.attempts}`;

    this.logger.log(`Scheduling reconnect attempt ${attemptLabel} in ${Math.round(delay / 1000)}s`, {
      sessionId: id,
      attempt: state.attempts,
      delayMs: delay,
      action: 'reconnect_scheduled',
    });

    state.timer = setTimeout(() => {
      state.timer = null;
      void this.executeReconnect(id, session, state);
    }, delay);
  }

  private async executeReconnect(id: string, session: Session, state: ReconnectState): Promise<void> {
    // The session may have been stopped/deleted before this fired — don't resurrect it.
    if (this.stoppingSessions.has(id)) {
      return;
    }
    try {
      // Clean up old engine
      const oldEngine = this.engines.get(id);
      if (oldEngine) {
        await oldEngine.destroy();
        this.engines.delete(id);
      }

      // Re-initialize
      await this.initializeEngine(id, session);

      // A stop()/delete() may have run while we awaited init — if so, tear down the engine we
      // just registered so it isn't orphaned (the session is meant to be down).
      if (this.stoppingSessions.has(id)) {
        const resurrected = this.engines.get(id);
        if (resurrected) {
          await resurrected.destroy();
          this.engines.delete(id);
        }
        return;
      }
    } catch (error: unknown) {
      await this.cleanupFailedEngine(id);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Reconnect attempt ${state.attempts} failed`, errorMessage, {
        sessionId: id,
        action: 'reconnect_error',
      });
      // Schedule another attempt
      this.scheduleReconnect(id, session);
    }
  }

  private isTerminalAuthenticationError(reason: string): boolean {
    return /auth(?:entication)? failed|logged out|invalid.*session|session.*invalid/i.test(reason);
  }

  private cancelReconnect(id: string): void {
    const state = this.reconnectStates.get(id);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.reconnectStates.delete(id);
  }

  async stop(id: string): Promise<Session> {
    const session = await this.findOne(id);

    // Mark as tearing down BEFORE cleanup so an in-flight reconnect can't resurrect it.
    this.stoppingSessions.add(id);
    // Cancel any reconnection attempts
    this.cancelReconnect(id);

    const engine = this.engines.get(id);

    if (engine) {
      await engine.disconnect();
      this.engines.delete(id);
    }

    this.logger.log(`Session stopped: ${session.name}`, {
      sessionId: id,
      action: 'stop',
    });
    await this.updateStatus(id, SessionStatus.DISCONNECTED);
    return this.findOne(id);
  }

  async getQRCode(id: string): Promise<{ qrCode: string; status: SessionStatus }> {
    const session = await this.findOne(id);
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started. Call POST /sessions/:id/start first.');
    }

    const qrCode = engine.getQRCode();

    if (!qrCode) {
      if (session.status === SessionStatus.READY) {
        throw new BadRequestException('Session is already authenticated, no QR code needed');
      }
      throw new BadRequestException('QR code is not ready yet. Please wait...');
    }

    return {
      qrCode,
      status: session.status,
    };
  }

  /**
   * Request an 8-char pairing code (link via phone number) as an alternative to scanning the QR.
   * The session must be started but not yet authenticated.
   */
  async requestPairingCode(id: string, phoneNumber: string): Promise<{ pairingCode: string; status: SessionStatus }> {
    const session = await this.findOne(id);
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started. Call POST /sessions/:id/start first.');
    }
    if (session.status === SessionStatus.READY) {
      throw new BadRequestException('Session is already authenticated, no pairing needed');
    }

    const pairingCode = await engine.requestPairingCode(phoneNumber);
    return { pairingCode, status: session.status };
  }

  getEngine(id: string): IWhatsAppEngine | undefined {
    return this.engines.get(id);
  }

  private buildStoredMessageMetadata(message: IncomingMessage): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};
    if (message.media) {
      metadata.media = message.media.storagePath
        ? {
            mimetype: message.media.mimetype,
            filename: message.media.filename,
            archived: true,
          }
        : message.media;
    }
    if (message.quotedMessage) metadata.quotedMessage = message.quotedMessage;
    if (message.location) metadata.location = message.location;
    if (message.contact) metadata.contact = message.contact;
    if (message.senderPhone) metadata.senderPhone = message.senderPhone;
    if (message.author) metadata.author = message.author;
    return metadata;
  }

  /**
   * Permanently store history returned by the engine. Repeated syncs are idempotent by WhatsApp
   * message id, and a later media-enabled fetch enriches the existing row instead of duplicating it.
   */
  async persistHistory(
    sessionId: string,
    messages: IncomingMessage[],
    chatIdOverride?: string,
  ): Promise<IncomingMessage[]> {
    const normalized = messages
      .filter(message => !message.isStatusBroadcast)
      .map(message => (chatIdOverride ? { ...message, chatId: chatIdOverride } : message));
    await this.persistMessages(sessionId, normalized);
    return normalized;
  }

  private async persistMessages(
    sessionId: string,
    messages: IncomingMessage[],
    chatIdOverride?: string,
    incrementUnread = false,
  ): Promise<void> {
    const previous = this.messagePersistQueues.get(sessionId) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(() => this.persistMessagesNow(sessionId, messages, chatIdOverride, incrementUnread));
    this.messagePersistQueues.set(sessionId, queued);
    return queued.finally(() => {
      if (this.messagePersistQueues.get(sessionId) === queued) this.messagePersistQueues.delete(sessionId);
    });
  }

  private async persistMessagesNow(
    sessionId: string,
    messages: IncomingMessage[],
    chatIdOverride?: string,
    incrementUnread = false,
  ): Promise<void> {
    const normalized = messages
      .filter(message => message.id && !message.isStatusBroadcast)
      .map(message => (chatIdOverride ? { ...message, chatId: chatIdOverride } : message));
    if (normalized.length === 0) return;

    const messageIds = [...new Set(normalized.map(message => message.id))];
    const existing = await this.messageRepository.find({
      where: { sessionId, waMessageId: In(messageIds) },
    });
    const existingById = new Map(existing.map(message => [message.waMessageId, message]));
    const rows: Message[] = [];

    for (const original of normalized) {
      const alreadyStored = existingById.get(original.id);
      const incoming =
        original.media && alreadyStored?.mediaPath
          ? {
              ...original,
              media: {
                ...original.media,
                mimetype: alreadyStored.mediaMimetype || original.media.mimetype,
                storagePath: alreadyStored.mediaPath,
              },
            }
          : await this.mediaArchiveService.archiveMessage(sessionId, original);
      const metadata = this.buildStoredMessageMetadata(incoming);
      const stored = existingById.get(incoming.id);

      if (stored) {
        stored.chatId = incoming.chatId || stored.chatId;
        stored.from = incoming.from || stored.from;
        stored.to = incoming.to || stored.to;
        stored.body = incoming.body || stored.body;
        stored.type = incoming.type === 'unknown' ? stored.type : incoming.type;
        stored.direction = incoming.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING;
        stored.timestamp = incoming.timestamp || stored.timestamp;
        stored.mediaPath = incoming.media?.storagePath || stored.mediaPath;
        stored.mediaMimetype = incoming.media?.mimetype || stored.mediaMimetype;
        if (![MessageStatus.DELIVERED, MessageStatus.READ].includes(stored.status)) {
          stored.status = MessageStatus.SENT;
        }
        stored.metadata = { ...(stored.metadata || {}), ...metadata };
        rows.push(stored);
        continue;
      }

      const row = this.messageRepository.create({
        sessionId,
        waMessageId: incoming.id,
        chatId: incoming.chatId,
        from: incoming.from,
        to: incoming.to,
        body: incoming.body,
        type: incoming.type,
        direction: incoming.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
        timestamp: incoming.timestamp,
        mediaPath: incoming.media?.storagePath,
        mediaMimetype: incoming.media?.mimetype,
        status: MessageStatus.SENT,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
      rows.push(row);
      existingById.set(incoming.id, row);
    }

    await this.messageRepository.save(rows);
    try {
      await this.persistMessageChatSnapshots(sessionId, normalized, incrementUnread);
    } catch (error) {
      // The message row is authoritative. A snapshot conflict must not suppress its websocket or
      // webhook delivery; the next chat refresh will rebuild the summary.
      this.logger.error(`Failed to update chat snapshot for session ${sessionId}`, String(error));
    }
  }

  private async persistMessageChatSnapshots(
    sessionId: string,
    messages: IncomingMessage[],
    incrementUnread: boolean,
  ): Promise<void> {
    const latestByChat = new Map<string, IncomingMessage>();
    const unreadByChat = new Map<string, number>();
    for (const message of messages) {
      if (!message.chatId) continue;
      const current = latestByChat.get(message.chatId);
      if (!current || this.toTimestamp(message.timestamp) >= this.toTimestamp(current.timestamp)) {
        latestByChat.set(message.chatId, message);
      }
      if (incrementUnread && !message.fromMe) {
        unreadByChat.set(message.chatId, (unreadByChat.get(message.chatId) ?? 0) + 1);
      }
    }
    const chatIds = [...latestByChat.keys()];
    if (chatIds.length === 0) return;

    const existing = await this.chatSnapshotRepository.find({
      where: { sessionId, chatId: In(chatIds) },
    });
    const byChatId = new Map(existing.map(snapshot => [snapshot.chatId, snapshot]));
    const snapshots: ChatSnapshot[] = [];

    for (const [chatId, message] of latestByChat) {
      const current = byChatId.get(chatId);
      const metadata = this.buildStoredMessageMetadata(message) as {
        senderPhone?: unknown;
        contact?: { name?: unknown; pushName?: unknown };
      };
      const contactPhone = message.isGroup
        ? null
        : this.normalizeContactPhone(metadata.senderPhone, chatId) || this.phoneFromDirectChatId(chatId);
      const contactName =
        (typeof metadata.contact?.name === 'string' && metadata.contact.name.trim()) ||
        (typeof metadata.contact?.pushName === 'string' && metadata.contact.pushName.trim()) ||
        null;
      const timestamp = this.toTimestamp(message.timestamp);
      const snapshot =
        current ??
        this.chatSnapshotRepository.create({
          sessionId,
          chatId,
          name: contactName || contactPhone || chatId,
          isGroup: message.isGroup || chatId.endsWith('@g.us'),
          unreadCount: 0,
          timestamp,
          lastMessage: null,
          contactPhone,
        });

      if (contactName || !this.isUsefulChatName(snapshot.name, chatId)) {
        snapshot.name = contactName || contactPhone || snapshot.name || chatId;
      }
      snapshot.isGroup = message.isGroup || chatId.endsWith('@g.us');
      snapshot.contactPhone = snapshot.contactPhone || contactPhone;
      snapshot.unreadCount = Math.max(0, snapshot.unreadCount || 0) + (unreadByChat.get(chatId) ?? 0);
      if (timestamp >= this.toTimestamp(snapshot.timestamp)) {
        snapshot.timestamp = timestamp;
        snapshot.lastMessage = this.messagePreview(message);
      }
      snapshots.push(snapshot);
    }

    await this.chatSnapshotRepository.save(snapshots);
    this.chatCache.delete(sessionId);
  }

  private async persistChatSummaries(sessionId: string, chats: ChatSummary[]): Promise<void> {
    if (chats.length === 0) return;
    const chatIds = [...new Set(chats.map(chat => chat.id).filter(Boolean))];
    const existing = await this.chatSnapshotRepository.find({
      where: { sessionId, chatId: In(chatIds) },
    });
    const byChatId = new Map(existing.map(snapshot => [snapshot.chatId, snapshot]));
    const snapshots: ChatSnapshot[] = [];

    for (const chat of chats) {
      const current = byChatId.get(chat.id);
      const contactPhone = chat.isGroup ? null : this.phoneFromDirectChatId(chat.id);
      const snapshot =
        current ??
        this.chatSnapshotRepository.create({
          sessionId,
          chatId: chat.id,
          name: chat.name || contactPhone || chat.id,
          isGroup: chat.isGroup,
          unreadCount: chat.unreadCount || 0,
          timestamp: this.toTimestamp(chat.timestamp),
          lastMessage: chat.lastMessage || null,
          contactPhone,
        });
      const liveName = chat.name?.trim();
      if (this.isUsefulChatName(liveName, chat.id) || !this.isUsefulChatName(snapshot.name, chat.id)) {
        snapshot.name = liveName || contactPhone || snapshot.name || chat.id;
      }
      snapshot.isGroup = chat.isGroup;
      snapshot.unreadCount = Math.max(0, chat.unreadCount || 0);
      snapshot.contactPhone = snapshot.contactPhone || contactPhone;
      if (this.toTimestamp(chat.timestamp) >= this.toTimestamp(snapshot.timestamp)) {
        snapshot.timestamp = this.toTimestamp(chat.timestamp);
        snapshot.lastMessage = chat.lastMessage || snapshot.lastMessage;
      }
      snapshots.push(snapshot);
    }

    await this.chatSnapshotRepository.save(snapshots);
  }

  private async persistSessionContacts(sessionId: string, contacts: Contact[]): Promise<void> {
    if (contacts.length === 0) return;
    const [savedContacts, snapshots] = await Promise.all([
      this.savedContactRepository.find({ where: { sessionId } }),
      this.chatSnapshotRepository.find({ where: { sessionId } }),
    ]);
    const savedByNumber = new Map(savedContacts.map(contact => [this.normalizeDigits(contact.number), contact]));
    const snapshotsByChatId = new Map(snapshots.map(snapshot => [snapshot.chatId, snapshot]));
    const contactsToSave = new Map<string, SavedContact>();
    const snapshotsToSave = new Map<string, ChatSnapshot>();

    for (const contact of contacts) {
      const phone = this.normalizeContactPhone(contact.number, contact.id);
      if (!phone) continue;
      const name = contact.name?.trim() || contact.pushName?.trim() || null;
      const saved =
        savedByNumber.get(phone) ??
        this.savedContactRepository.create({ sessionId, number: phone, name, source: 'session' });
      saved.number = phone;
      saved.name = saved.name?.trim() || name;
      saved.source = saved.source || 'session';
      savedByNumber.set(phone, saved);
      contactsToSave.set(phone, saved);

      const snapshot = snapshotsByChatId.get(contact.id);
      if (snapshot) {
        snapshot.contactPhone = phone;
        if (name) snapshot.name = name;
        snapshotsToSave.set(snapshot.chatId, snapshot);
      }
    }

    if (contactsToSave.size > 0) await this.savedContactRepository.save([...contactsToSave.values()]);
    if (snapshotsToSave.size > 0) await this.chatSnapshotRepository.save([...snapshotsToSave.values()]);
  }

  private startArchiveSync(sessionId: string, engine: IWhatsAppEngine): Promise<void> {
    const running = this.archiveSyncs.get(sessionId);
    if (running) return running;

    const sync = this.syncDurableSessionData(sessionId, engine)
      .catch(error => {
        this.logger.warn(`Background history sync stopped for session ${sessionId}`, {
          sessionId,
          reason: error instanceof Error ? error.message : String(error),
          action: 'history_sync_failed',
        });
      })
      .finally(() => this.archiveSyncs.delete(sessionId));
    this.archiveSyncs.set(sessionId, sync);
    return sync;
  }

  private async syncDurableSessionData(sessionId: string, engine: IWhatsAppEngine): Promise<void> {
    if (this.engines.get(sessionId) !== engine || engine.getStatus() !== EngineStatus.READY) return;

    const chats = await this.refreshChats(sessionId, engine);
    try {
      await this.persistSessionContacts(sessionId, await engine.getContacts());
    } catch (error) {
      this.logger.warn(`Contact snapshot sync failed for session ${sessionId}`, {
        sessionId,
        reason: error instanceof Error ? error.message : String(error),
        action: 'contact_sync_failed',
      });
    }

    const configuredLimit = Number(process.env.SESSION_HISTORY_SYNC_LIMIT ?? SessionService.DEFAULT_HISTORY_SYNC_LIMIT);
    const historyLimit = Number.isFinite(configuredLimit)
      ? Math.min(Math.max(Math.trunc(configuredLimit), 1), 2000)
      : SessionService.DEFAULT_HISTORY_SYNC_LIMIT;
    const configuredDelay = Number(process.env.SESSION_HISTORY_SYNC_DELAY_MS ?? 75);
    const syncDelay = Number.isFinite(configuredDelay) ? Math.max(Math.trunc(configuredDelay), 0) : 75;

    for (const chat of chats) {
      if (
        this.stoppingSessions.has(sessionId) ||
        this.engines.get(sessionId) !== engine ||
        engine.getStatus() !== EngineStatus.READY
      ) {
        break;
      }
      try {
        const history = await engine.getChatHistory(chat.id, historyLimit, false);
        await this.persistHistory(sessionId, history, chat.id);
      } catch (error) {
        this.logger.debug(`Could not archive chat ${chat.id}`, {
          sessionId,
          reason: error instanceof Error ? error.message : String(error),
          action: 'chat_history_sync_skipped',
        });
      }
      if (syncDelay > 0) await this.delay(syncDelay);
    }
  }

  private phoneFromDirectChatId(chatId: string): string | null {
    if (!chatId.endsWith('@c.us') && !chatId.endsWith('@s.whatsapp.net')) return null;
    return this.normalizeDigits(chatId.split('@')[0]) || null;
  }

  private normalizeContactPhone(value: unknown, contactId: string): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const phone = this.normalizeDigits(String(value));
    if (!phone) return null;
    const privacyId = contactId.endsWith('@lid') ? this.normalizeDigits(contactId.split('@')[0]) : '';
    return privacyId && privacyId === phone ? null : phone;
  }

  private normalizeDigits(value: string): string {
    return value.replace(/\D/g, '');
  }

  private isUsefulChatName(name: string | null | undefined, chatId: string): boolean {
    const value = name?.trim();
    return Boolean(value && value !== chatId && !value.includes('@'));
  }

  private messagePreview(message: IncomingMessage): string | null {
    if (message.body?.trim()) return message.body;
    if (message.type === 'unknown') return null;
    return `[${message.type}]`;
  }

  private toTimestamp(value: number | string | null | undefined): number {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  private async persistOutgoingEngineMessage(sessionId: string, outgoing: IncomingMessage): Promise<void> {
    try {
      outgoing = await this.mediaArchiveService.archiveMessage(sessionId, outgoing);
      let stored = await this.messageRepository.findOne({
        where: { sessionId, waMessageId: outgoing.id },
      });

      // Evolution Go sends Aurora's deterministic client id back as the WhatsApp id. Match it before
      // body-based fallbacks so concurrent identical sends and retry echoes update the correct row.
      if (!stored) {
        const pendingCandidates = await this.messageRepository.find({
          where: {
            sessionId,
            direction: MessageDirection.OUTGOING,
            status: In([MessageStatus.PENDING, MessageStatus.FAILED]),
          },
          order: { createdAt: 'DESC' },
          take: 100,
        });
        stored = pendingCandidates.find(message => message.metadata?.clientMessageId === outgoing.id) ?? null;
      }

      // During an API send, message_create can arrive before MessageService has attached the WhatsApp
      // id to its pending row. Match the newest pending copy by chat/body before creating a new row.
      if (!stored) {
        stored = await this.messageRepository.findOne({
          where: {
            sessionId,
            chatId: outgoing.chatId,
            body: outgoing.body,
            direction: MessageDirection.OUTGOING,
            status: MessageStatus.PENDING,
            createdAt: MoreThan(new Date(Date.now() - 2 * 60 * 1000)),
          },
          order: { createdAt: 'DESC' },
        });
      }

      // Canonical sends may echo with a phone JID while the API pending row intentionally keeps the
      // original privacy-id chat for dashboard continuity. Match that very recent row by body/type.
      if (!stored) {
        stored = await this.messageRepository.findOne({
          where: {
            sessionId,
            body: outgoing.body,
            type: outgoing.type,
            direction: MessageDirection.OUTGOING,
            status: MessageStatus.PENDING,
            createdAt: MoreThan(new Date(Date.now() - 2 * 60 * 1000)),
          },
          order: { createdAt: 'DESC' },
        });
      }

      const incomingMetadata = this.buildStoredMessageMetadata(outgoing);
      if (stored) {
        stored.waMessageId = outgoing.id;
        stored.from = outgoing.from;
        stored.to = outgoing.to;
        stored.body = outgoing.body || stored.body;
        stored.type = outgoing.type === 'unknown' ? stored.type : outgoing.type;
        stored.timestamp = outgoing.timestamp;
        stored.mediaPath = outgoing.media?.storagePath || stored.mediaPath;
        stored.mediaMimetype = outgoing.media?.mimetype || stored.mediaMimetype;
        stored.status = MessageStatus.SENT;
        stored.metadata = { ...(stored.metadata || {}), ...incomingMetadata };
        await this.messageRepository.save(stored);
        await this.persistMessageChatSnapshots(sessionId, [{ ...outgoing, chatId: stored.chatId }], false);
        return;
      }

      const message = this.messageRepository.create({
        sessionId,
        waMessageId: outgoing.id,
        chatId: outgoing.chatId,
        from: outgoing.from,
        to: outgoing.to,
        body: outgoing.body,
        type: outgoing.type,
        direction: MessageDirection.OUTGOING,
        timestamp: outgoing.timestamp,
        mediaPath: outgoing.media?.storagePath,
        mediaMimetype: outgoing.media?.mimetype,
        status: MessageStatus.SENT,
        metadata: Object.keys(incomingMetadata).length > 0 ? incomingMetadata : undefined,
      });
      await this.messageRepository.save(message);
      await this.persistMessageChatSnapshots(sessionId, [outgoing], false);
    } catch (error) {
      this.logger.error(`Failed to persist outgoing engine message ${outgoing.id}`, String(error));
    }
  }

  /**
   * Best-effort resolution of a privacy-id sender (`@lid`) to a phone number for inline attachment on
   * incoming messages (#263). Cached per session (incl. misses). Never throws — returns null on any
   * failure or when the engine isn't available. Gated by the caller on `RESOLVE_LID_TO_PHONE`.
   */
  private async resolveSenderPhone(sessionId: string, contactId: string): Promise<string | null> {
    const key = `${sessionId}:${contactId}`;
    const cached = this.lidPhoneCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let phone: string | null;
    try {
      phone = (await this.getEngine(sessionId)?.resolveContactPhone(contactId)) ?? null;
    } catch {
      // A dead page/evaluation failure is transient. Do not turn it into a cached negative that
      // suppresses future resolution attempts for the rest of this process.
      return null;
    }
    // Bounded FIFO eviction: Map preserves insertion order, so the first key is the oldest.
    if (this.lidPhoneCache.size >= SessionService.LID_PHONE_CACHE_MAX) {
      for (const oldest of this.lidPhoneCache.keys()) {
        this.lidPhoneCache.delete(oldest);
        break;
      }
    }
    this.lidPhoneCache.set(key, phone);
    return phone;
  }

  async getGroups(id: string): Promise<{ id: string; name: string; linkedParentJID?: string | null }[]> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    const groups = await engine.getGroups();
    return groups.map(g => ({
      id: g.id,
      name: g.name,
      linkedParentJID: g.linkedParentJID,
    }));
  }

  async getChats(id: string): Promise<ChatSummary[]> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      return this.getChatsFromStoredMessages(id);
    }

    return this.refreshChats(id, engine);
  }

  /**
   * Returns the inbox from persisted messages/cache without blocking the request on a full
   * WhatsApp Web chat scan. A single background refresh keeps the next poll current.
   */
  async getChatsFast(id: string): Promise<ChatSummary[]> {
    await this.findOne(id);
    const engine = this.engines.get(id);
    const storedChats = await this.getChatsFromStoredMessages(id);
    const cached = this.chatCache.get(id);

    if (engine && (!cached || cached.expiresAt <= Date.now())) {
      void this.refreshChats(id, engine).catch(() => undefined);
    }

    return this.mergeChats(cached?.chats ?? [], storedChats);
  }

  private async refreshChats(id: string, engine: IWhatsAppEngine): Promise<ChatSummary[]> {
    const existingRefresh = this.chatRefreshes.get(id);
    if (existingRefresh) {
      return existingRefresh;
    }

    const refresh = this.fetchAndCacheChats(id, engine).finally(() => {
      this.chatRefreshes.delete(id);
    });
    this.chatRefreshes.set(id, refresh);
    return refresh;
  }

  private async fetchAndCacheChats(id: string, engine: IWhatsAppEngine): Promise<ChatSummary[]> {
    let chatFetchTimer: NodeJS.Timeout | undefined;
    try {
      const liveChats = await Promise.race([
        engine.getChats(),
        new Promise<ChatSummary[]>((_, reject) => {
          chatFetchTimer = setTimeout(
            () => reject(new Error('Timed out waiting for WhatsApp chat list')),
            SessionService.CHAT_FETCH_TIMEOUT_MS,
          );
        }),
      ]);
      await this.persistChatSummaries(id, liveChats);
      const storedChats = await this.getChatsFromStoredMessages(id);
      const chats = this.mergeChats(liveChats, storedChats);
      this.chatCache.set(id, { chats, expiresAt: Date.now() + SessionService.CHAT_CACHE_TTL_MS });
      return chats;
    } catch (error) {
      this.logger.warn(`Live chat fetch failed for session ${id}; falling back to stored messages`, {
        sessionId: id,
        reason: error instanceof Error ? error.message : String(error),
        action: 'get_chats_fallback',
      });
      const chats = await this.getChatsFromStoredMessages(id);
      this.chatCache.set(id, { chats, expiresAt: Date.now() + SessionService.CHAT_CACHE_TTL_MS });
      return chats;
    } finally {
      if (chatFetchTimer) clearTimeout(chatFetchTimer);
    }
  }

  private mergeChats(primary: ChatSummary[], stored: ChatSummary[]): ChatSummary[] {
    const merged = new Map(primary.map(chat => [chat.id, chat]));

    for (const storedChat of stored) {
      const liveChat = merged.get(storedChat.id);
      if (!liveChat) {
        merged.set(storedChat.id, storedChat);
        continue;
      }

      if ((storedChat.timestamp || 0) > (liveChat.timestamp || 0)) {
        merged.set(storedChat.id, {
          ...liveChat,
          name: this.isUsefulChatName(liveChat.name, liveChat.id) ? liveChat.name : storedChat.name,
          timestamp: storedChat.timestamp,
          lastMessage: storedChat.lastMessage || liveChat.lastMessage,
        });
      } else if (
        !this.isUsefulChatName(liveChat.name, liveChat.id) &&
        this.isUsefulChatName(storedChat.name, storedChat.id)
      ) {
        merged.set(storedChat.id, { ...liveChat, name: storedChat.name });
      }
    }

    return [...merged.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  private async getChatsFromStoredMessages(sessionId: string): Promise<ChatSummary[]> {
    const [snapshots, messages] = await Promise.all([
      this.chatSnapshotRepository.find({
        where: { sessionId },
        order: { timestamp: 'DESC', updatedAt: 'DESC' },
      }),
      this.messageRepository.find({
        where: { sessionId },
        order: { timestamp: 'DESC', createdAt: 'DESC' },
        take: SessionService.CHAT_FALLBACK_MESSAGE_SCAN,
      }),
    ]);

    const chats = new Map<string, ChatSummary>();
    for (const snapshot of snapshots) {
      chats.set(snapshot.chatId, {
        id: snapshot.chatId,
        name: snapshot.name || snapshot.contactPhone || snapshot.chatId,
        isGroup: snapshot.isGroup,
        unreadCount: Math.max(0, snapshot.unreadCount || 0),
        timestamp: this.toTimestamp(snapshot.timestamp),
        lastMessage: snapshot.lastMessage || undefined,
      });
    }

    for (const message of messages) {
      if (!message.chatId) continue;
      const current = chats.get(message.chatId);
      const metadata = message.metadata as
        | { senderPhone?: unknown; contact?: { name?: unknown; pushName?: unknown } }
        | undefined;
      const phone =
        this.normalizeContactPhone(metadata?.senderPhone, message.chatId) || this.phoneFromDirectChatId(message.chatId);
      const contactName =
        (typeof metadata?.contact?.name === 'string' && metadata.contact.name.trim()) ||
        (typeof metadata?.contact?.pushName === 'string' && metadata.contact.pushName.trim()) ||
        null;
      const timestamp =
        this.toTimestamp(message.timestamp) ||
        (message.createdAt instanceof Date ? Math.floor(message.createdAt.getTime() / 1000) : 0);
      const name = contactName || phone || current?.name || message.chatId;

      if (!current) {
        chats.set(message.chatId, {
          id: message.chatId,
          name,
          isGroup: message.chatId.endsWith('@g.us'),
          unreadCount: 0,
          timestamp,
          lastMessage: message.body || (message.type !== 'unknown' ? `[${message.type}]` : undefined),
        });
        continue;
      }

      if (!this.isUsefulChatName(current.name, current.id) && this.isUsefulChatName(name, message.chatId)) {
        current.name = name;
      }
      if (timestamp > (current.timestamp || 0)) {
        current.timestamp = timestamp;
        current.lastMessage = message.body || (message.type !== 'unknown' ? `[${message.type}]` : current.lastMessage);
      }
    }

    return [...chats.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  async sendSeen(id: string, chatId: string): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    await this.chatSnapshotRepository.update({ sessionId: id, chatId }, { unreadCount: 0 });
    const engine = this.engines.get(id);

    if (!engine || engine.getStatus() !== EngineStatus.READY) return false;

    return engine.sendSeen(chatId);
  }

  async deleteChat(id: string, chatId: string): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    return engine.deleteChat(chatId);
  }

  async sendChatState(id: string, chatId: string, state: ChatState): Promise<void> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    await engine.sendChatState(chatId, state);
  }

  private async updateStatus(id: string, status: SessionStatus): Promise<void> {
    await this.sessionRepository.update(id, { status });
    this.logger.debug(`Session status updated to ${status}`, {
      sessionId: id,
      status,
      action: 'status_update',
    });
    // Emit real-time event to connected WebSocket clients
    this.eventsGateway.emitSessionStatus(id, status);
  }

  /**
   * Get overall session statistics for multi-session monitoring
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    ready: number;
    disconnected: number;
    byStatus: Record<string, number>;
    memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
  }> {
    const sessions = await this.findAll();
    const byStatus: Record<string, number> = {};

    for (const session of sessions) {
      byStatus[session.status] = (byStatus[session.status] || 0) + 1;
    }

    const memory = process.memoryUsage();

    return {
      total: sessions.length,
      active: this.engines.size,
      ready: byStatus[SessionStatus.READY] || 0,
      disconnected: byStatus[SessionStatus.DISCONNECTED] || 0,
      byStatus,
      memoryUsage: {
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
        rss: Math.round(memory.rss / 1024 / 1024),
      },
    };
  }

  /**
   * Get count of currently active (running) sessions
   */
  getActiveCount(): number {
    return this.engines.size;
  }

  /**
   * Check if session is currently active (engine running)
   */
  isActive(id: string): boolean {
    return this.engines.has(id);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
