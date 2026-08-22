import { Injectable, BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionService } from '../session/session.service';
import { SendTextMessageDto, SendMediaMessageDto, MessageResponseDto } from './dto';
import { SendTemplateMessageDto } from './dto/send-template.dto';
import { EngineStatus, MediaInput, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { HookManager } from '../../core/hooks';
import { TemplateService } from '../template/template.service';
import { renderTemplate } from '../../common/utils/template-render';
import { createLogger } from '../../common/services/logger.service';
import { SsrfBlockedError } from '../../common/security/ssrf-guard';
import { EngineNotReadyError, WHATSAPP_SESSION_DISCONNECTED_MESSAGE } from '../../common/errors/engine-not-ready.error';
import { MediaArchiveService } from '../../common/media/media-archive.service';
import { randomUUID } from 'crypto';
import { outboundClientMessageId, readOutboundRetryPayload } from './message-retry.types';

export interface GetMessagesOptions {
  chatId?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class MessageService {
  private readonly logger = createLogger('MessageService');

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly sessionService: SessionService,
    private readonly hookManager: HookManager,
    private readonly templateService: TemplateService,
    private readonly mediaArchiveService: MediaArchiveService,
  ) {}

  async sendText(sessionId: string, dto: SendTextMessageDto): Promise<MessageResponseDto> {
    // Execute hook before sending - plugins can modify or block
    const { continue: shouldContinue, data: hookData } = await this.hookManager.execute(
      'message:sending',
      { sessionId, input: dto, type: 'text' },
      { sessionId, source: 'MessageService' },
    );

    if (!shouldContinue) {
      throw new BadRequestException('Message sending blocked by plugin');
    }

    // Use potentially modified input
    const finalDto = (hookData as { input: SendTextMessageDto }).input;

    const engine = this.getEngine(sessionId);
    const sendChatId = await this.resolveSendChatId(sessionId, engine, finalDto.chatId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: finalDto.text,
      type: 'text',
      metadata: { retry: { kind: 'text', chatId: finalDto.chatId, text: finalDto.text } },
    });

    // Opt-in humanising "typing…" pause before the actual send (anti-automation signal).
    await this.simulateTypingIfEnabled(engine, sendChatId, finalDto.text);

    try {
      const result = await engine.sendTextMessage(sendChatId, finalDto.text, this.messageClientId(message.id));

      // Update with actual WhatsApp message ID and status
      await this.markMessageSent(message, result);

      // Note: the `message:sent` hook is emitted solely by SessionService.onMessageCreate (engine
      // `message_create`) with a consistent IncomingMessage payload for ALL sends (text, media,
      // and phone-composed), so it is intentionally not fired here to avoid a double dispatch.
      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      // Mark as failed
      await this.markMessageFailed(message, error);

      // Execute hook on failure
      try {
        await this.hookManager.execute(
          'message:failed',
          { sessionId, error: error instanceof Error ? error.message : String(error), input: finalDto },
          { sessionId, source: 'MessageService' },
        );
      } catch (hookError) {
        this.logger.warn(
          `message:failed hook error: ${hookError instanceof Error ? hookError.message : String(hookError)}`,
        );
      }

      throw this.toClientFacingError(error);
    }
  }

  /**
   * Resolve a stored template, render its body (with optional header/footer
   * flattened using newlines) using the supplied variables, and delegate to the
   * existing {@link sendText} path so plugin hooks, persistence, and status
   * tracking are reused. Throws NotFoundException when the template cannot be
   * resolved by id or name.
   */
  async sendTemplate(sessionId: string, dto: SendTemplateMessageDto): Promise<MessageResponseDto> {
    const template = await this.templateService.resolve(sessionId, {
      templateId: dto.templateId,
      templateName: dto.templateName,
    });

    const vars = dto.vars ?? {};
    const segments = [template.header, template.body, template.footer]
      .filter((segment): segment is string => segment != null && segment.length > 0)
      .map(segment => renderTemplate(segment, vars));
    const text = segments.join('\n\n');

    return this.sendText(sessionId, { chatId: dto.chatId, text });
  }

  async sendImage(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const sendChatId = await this.resolveSendChatId(sessionId, engine, dto.chatId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: dto.caption || '',
      type: 'image',
      metadata: {
        media: { mimetype: dto.mimetype, filename: dto.filename, data: dto.base64 || dto.url },
        retry: { kind: 'image', chatId: dto.chatId, caption: dto.caption },
      },
    });

    try {
      const result = await engine.sendImageMessage(sendChatId, {
        ...media,
        clientMessageId: this.messageClientId(message.id),
      });

      // Update with actual WhatsApp message ID and status
      await this.markMessageSent(message, result);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      await this.markMessageFailed(message, error);
      throw this.toClientFacingError(error);
    }
  }

  async sendVideo(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const sendChatId = await this.resolveSendChatId(sessionId, engine, dto.chatId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: dto.caption || '',
      type: 'video',
      metadata: {
        media: { mimetype: dto.mimetype, filename: dto.filename, data: dto.base64 || dto.url },
        retry: { kind: 'video', chatId: dto.chatId, caption: dto.caption },
      },
    });

    try {
      const result = await engine.sendVideoMessage(sendChatId, {
        ...media,
        clientMessageId: this.messageClientId(message.id),
      });

      // Update with actual WhatsApp message ID and status
      await this.markMessageSent(message, result);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      await this.markMessageFailed(message, error);
      throw this.toClientFacingError(error);
    }
  }

  async sendAudio(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const sendChatId = await this.resolveSendChatId(sessionId, engine, dto.chatId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      type: 'audio',
      metadata: {
        media: { mimetype: dto.mimetype, filename: dto.filename, data: dto.base64 || dto.url },
        retry: { kind: 'audio', chatId: dto.chatId },
      },
    });

    try {
      const result = await engine.sendAudioMessage(sendChatId, {
        ...media,
        clientMessageId: this.messageClientId(message.id),
      });

      // Update with actual WhatsApp message ID and status
      await this.markMessageSent(message, result);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      await this.markMessageFailed(message, error);
      throw this.toClientFacingError(error);
    }
  }

  async sendDocument(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const sendChatId = await this.resolveSendChatId(sessionId, engine, dto.chatId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: dto.filename || '',
      type: 'document',
      metadata: {
        media: { mimetype: dto.mimetype, filename: dto.filename, data: dto.base64 || dto.url },
        retry: { kind: 'document', chatId: dto.chatId, caption: dto.caption },
      },
    });

    try {
      const result = await engine.sendDocumentMessage(sendChatId, {
        ...media,
        clientMessageId: this.messageClientId(message.id),
      });

      // Update with actual WhatsApp message ID and status
      await this.markMessageSent(message, result);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      await this.markMessageFailed(message, error);
      throw this.toClientFacingError(error);
    }
  }

  /**
   * Get message history for a session
   */
  async getMessages(
    sessionId: string,
    options: GetMessagesOptions = {},
  ): Promise<{ messages: Message[]; total: number }> {
    const { chatId } = options;
    // Sanitize pagination: a non-finite limit/offset — e.g. `?limit=abc` -> NaN —
    // must never reach TypeORM's take()/skip(). Clamp to sane bounds; fall back to defaults.
    const rawLimit = options.limit;
    const rawOffset = options.offset;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 50;
    const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;

    const query = this.messageRepository
      .createQueryBuilder('message')
      .where('message.sessionId = :sessionId', { sessionId })
      .orderBy('message.timestamp', 'DESC', 'NULLS LAST')
      .addOrderBy('message.createdAt', 'DESC')
      .addOrderBy('message.id', 'DESC')
      .skip(offset)
      .take(limit);

    if (chatId) {
      query.andWhere('message.chatId = :chatId', { chatId });
    }

    const [messages, total] = await query.getManyAndCount();
    return { messages: messages.map(message => this.toPublicMessage(message)), total };
  }

  async getArchivedMedia(
    sessionId: string,
    messageId: string,
  ): Promise<{ data: string; mimetype: string; filename?: string }> {
    const message = await this.messageRepository.findOne({ where: { id: messageId, sessionId } });
    if (!message?.mediaPath) throw new NotFoundException('Archived media is not available for this message');

    try {
      const data = await this.mediaArchiveService.read(message.mediaPath);
      const media = this.readMediaMetadata(message.metadata);
      return {
        data: data.toString('base64'),
        mimetype: message.mediaMimetype || media?.mimetype || 'application/octet-stream',
        filename: media?.filename,
      };
    } catch (error) {
      this.logger.warn(`Could not read archived media ${message.id}`, {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new NotFoundException('Archived media is not available for this message');
    }
  }

  // ========== Phase 3: Extended Messaging ==========

  async sendLocation(
    sessionId: string,
    dto: { chatId: string; latitude: number; longitude: number; description?: string; address?: string },
  ): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const sendChatId = await this.resolveSendChatId(sessionId, engine, dto.chatId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: `📍 ${dto.description || 'Location'}`,
      type: 'location',
      metadata: {
        retry: {
          kind: 'location',
          chatId: dto.chatId,
          latitude: dto.latitude,
          longitude: dto.longitude,
          description: dto.description,
          address: dto.address,
        },
      },
    });

    try {
      const result = await engine.sendLocationMessage(sendChatId, {
        latitude: dto.latitude,
        longitude: dto.longitude,
        description: dto.description,
        address: dto.address,
        clientMessageId: this.messageClientId(message.id),
      });

      // Update with actual WhatsApp message ID and status
      await this.markMessageSent(message, result);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      await this.markMessageFailed(message, error);
      throw this.toClientFacingError(error);
    }
  }

  async sendContact(
    sessionId: string,
    dto: { chatId: string; contactName: string; contactNumber: string },
  ): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const sendChatId = await this.resolveSendChatId(sessionId, engine, dto.chatId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: `📇 ${dto.contactName}`,
      type: 'contact',
      metadata: {
        retry: {
          kind: 'contact',
          chatId: dto.chatId,
          contactName: dto.contactName,
          contactNumber: dto.contactNumber,
        },
      },
    });

    try {
      const result = await engine.sendContactMessage(sendChatId, {
        name: dto.contactName,
        number: dto.contactNumber,
        clientMessageId: this.messageClientId(message.id),
      });

      // Update with actual WhatsApp message ID and status
      await this.markMessageSent(message, result);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      await this.markMessageFailed(message, error);
      throw this.toClientFacingError(error);
    }
  }

  async sendSticker(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const sendChatId = await this.resolveSendChatId(sessionId, engine, dto.chatId);
    const media = this.buildMediaInput(dto);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      type: 'sticker',
      metadata: {
        media: { mimetype: dto.mimetype, filename: dto.filename, data: dto.base64 || dto.url },
        retry: { kind: 'sticker', chatId: dto.chatId },
      },
    });

    try {
      const result = await engine.sendStickerMessage(sendChatId, {
        ...media,
        clientMessageId: this.messageClientId(message.id),
      });

      // Update with actual WhatsApp message ID and status
      await this.markMessageSent(message, result);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      await this.markMessageFailed(message, error);
      throw this.toClientFacingError(error);
    }
  }

  async reply(
    sessionId: string,
    dto: { chatId: string; quotedMessageId: string; text: string },
  ): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const sendChatId = await this.resolveSendChatId(sessionId, engine, dto.chatId);

    // Resolve the quoted message body (best-effort) so the dashboard can render the reply preview.
    let quotedBody = '';
    try {
      const quoted = await this.messageRepository.findOne({
        where: { sessionId, waMessageId: dto.quotedMessageId },
      });
      quotedBody = quoted?.body || '';
    } catch (err) {
      this.logger.warn(`Failed to resolve quoted message ${dto.quotedMessageId}`, { error: String(err) });
    }

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.chatId,
      body: dto.text,
      type: 'text',
      metadata: {
        quotedMessage: { id: dto.quotedMessageId, body: quotedBody },
        retry: {
          kind: 'reply',
          chatId: dto.chatId,
          quotedMessageId: dto.quotedMessageId,
          text: dto.text,
        },
      },
    });

    try {
      const result = await engine.replyToMessage(
        sendChatId,
        dto.quotedMessageId,
        dto.text,
        this.messageClientId(message.id),
      );

      // Update with actual WhatsApp message ID and status
      await this.markMessageSent(message, result);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      await this.markMessageFailed(message, error);
      throw this.toClientFacingError(error);
    }
  }

  async forward(
    sessionId: string,
    dto: { fromChatId: string; toChatId: string; messageId: string },
  ): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    const fromChatId = await this.resolveSendChatId(sessionId, engine, dto.fromChatId);
    const toChatId = await this.resolveSendChatId(sessionId, engine, dto.toChatId);

    // Save message as pending BEFORE sending
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: dto.toChatId,
      body: '[Forwarded]',
      type: 'forward',
    });

    try {
      const result = await engine.forwardMessage(fromChatId, toChatId, dto.messageId);

      // Update with actual WhatsApp message ID and status
      await this.markMessageSent(message, result);

      return {
        messageId: result.id,
        timestamp: result.timestamp,
      };
    } catch (error) {
      await this.markMessageFailed(message, error);
      throw this.toClientFacingError(error);
    }
  }

  /**
   * Save incoming message (called from session webhook dispatch)
   */
  async saveIncomingMessage(sessionId: string, data: Partial<Message>): Promise<Message> {
    const message = this.messageRepository.create({
      ...data,
      sessionId,
      direction: MessageDirection.INCOMING,
    });
    return this.messageRepository.save(message);
  }

  /**
   * Save outgoing message to database.
   * When called before sending, creates a record with PENDING status.
   */
  private async saveOutgoingMessage(
    sessionId: string,
    data: {
      waMessageId?: string;
      chatId: string;
      body?: string;
      type: string;
      timestamp?: number;
      status?: MessageStatus;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Message> {
    const session = await this.sessionService.findOne(sessionId);
    const id = randomUUID();
    let metadata: Record<string, unknown> = {
      ...(data.metadata || {}),
      clientMessageId: this.messageClientId(id),
    };
    let mediaPath: string | undefined;
    let mediaMimetype: string | undefined;
    const media = this.readMediaMetadata(metadata);
    if (media) {
      try {
        const archived = await this.mediaArchiveService.archiveMedia(
          sessionId,
          id,
          data.timestamp ?? Math.floor(Date.now() / 1000),
          media,
        );
        mediaPath = archived.storagePath;
        mediaMimetype = archived.mimetype;
        metadata = {
          ...(metadata || {}),
          media: {
            mimetype: archived.mimetype,
            filename: archived.filename,
            archived: true,
          },
        };
      } catch (error) {
        // Sending should still proceed if archival storage is temporarily unavailable. The raw
        // metadata remains as a fallback and a later engine echo can archive the attachment.
        this.logger.warn('Could not archive outgoing media before send', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const message = this.messageRepository.create({
      id,
      sessionId,
      waMessageId: data.waMessageId,
      chatId: data.chatId,
      from: session?.phone || 'me',
      to: data.chatId,
      body: data.body,
      type: data.type,
      direction: MessageDirection.OUTGOING,
      timestamp: data.timestamp,
      status: data.status ?? MessageStatus.PENDING,
      metadata,
      mediaPath,
      mediaMimetype,
    });
    return this.messageRepository.save(message);
  }

  private async markMessageSent(message: Message, result: { id: string; timestamp: number }): Promise<void> {
    message.waMessageId = result.id;
    message.status = MessageStatus.SENT;
    message.timestamp = result.timestamp;
    message.nextRetryAt = null;
    message.lastError = null;
    if (message.metadata?.retry) {
      const metadata = { ...message.metadata };
      Reflect.deleteProperty(metadata, 'retry');
      message.metadata = metadata;
    }
    await this.messageRepository.save(message);
  }

  private async markMessageFailed(message: Message, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    const retryPayload = readOutboundRetryPayload(message.metadata);
    message.status = MessageStatus.FAILED;
    message.lastError = reason.slice(0, 2000);
    message.nextRetryAt =
      retryPayload && this.isRetryableSendError(error)
        ? new Date(Date.now() + Math.max(Number(process.env.MESSAGE_RETRY_BASE_DELAY_MS) || 15_000, 1000))
        : null;
    await this.messageRepository.save(message);
  }

  private isRetryableSendError(error: unknown): boolean {
    if (error instanceof EngineNotReadyError) return true;
    if (error instanceof HttpException) return error.getStatus() >= 500;
    const reason = error instanceof Error ? error.message : String(error);
    return /timeout|timed out|network|socket|econn|connection|disconnected|temporar|unavailable|502|503|504/i.test(
      reason,
    );
  }

  private messageClientId(messageId: string): string {
    return outboundClientMessageId(messageId);
  }

  private readMediaMetadata(metadata?: Record<string, unknown>):
    | {
        mimetype: string;
        filename?: string;
        data?: string;
        url?: string;
        storagePath?: string;
      }
    | undefined {
    const value = metadata?.media;
    if (!value || typeof value !== 'object') return undefined;
    const media = value as Record<string, unknown>;
    const mimetype = typeof media.mimetype === 'string' ? media.mimetype : 'application/octet-stream';
    return {
      mimetype,
      filename: typeof media.filename === 'string' ? media.filename : undefined,
      data: typeof media.data === 'string' ? media.data : undefined,
      url: typeof media.url === 'string' ? media.url : undefined,
      storagePath: typeof media.storagePath === 'string' ? media.storagePath : undefined,
    };
  }

  private toPublicMessage(message: Message): Message {
    if (!message.mediaPath) return message;
    const metadata = { ...(message.metadata || {}) };
    const media = this.readMediaMetadata(metadata);
    metadata.media = {
      mimetype: message.mediaMimetype || media?.mimetype || 'application/octet-stream',
      filename: media?.filename,
      archived: true,
    };
    const result = { ...message, metadata };
    Reflect.deleteProperty(result, 'mediaPath');
    Reflect.deleteProperty(result, 'mediaMimetype');
    return result;
  }

  // ========== Phase 3: Reactions ==========

  async reactToMessage(sessionId: string, dto: { chatId: string; messageId: string; emoji: string }): Promise<void> {
    const engine = this.getEngine(sessionId);
    await engine.reactToMessage(dto.chatId, dto.messageId, dto.emoji);
  }

  async getMessageReactions(sessionId: string, chatId: string, messageId: string) {
    const engine = this.getEngine(sessionId);
    return engine.getMessageReactions(chatId, messageId);
  }

  /** Maximum messages a single getChatHistory call may request from the engine. */
  private static readonly MAX_CHAT_HISTORY_LIMIT = 500;
  /** Recent persisted rows inspected when recovering a canonical address for a privacy-id chat. */
  private static readonly CONTACT_ADDRESS_SCAN_LIMIT = 25;

  /**
   * Fetch chat history live from WhatsApp (bypasses local DB).
   * Returns the most recent `limit` messages for the given chat.
   * When `includeMedia` is true, downloads media (base64) for messages that have it.
   *
   * `limit` is clamped to [1, 500] (and falls back to 50 for non-finite input) so a
   * caller cannot ask the engine to fetch an unbounded number of messages.
   */
  async getChatHistory(sessionId: string, chatId: string, limit = 50, includeMedia = false) {
    const engine = this.getEngine(sessionId);
    const safeLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), MessageService.MAX_CHAT_HISTORY_LIMIT)
      : 50;

    try {
      const history = await engine.getChatHistory(chatId, safeLimit, includeMedia);
      return this.sessionService.persistHistory(sessionId, history, chatId);
    } catch (originalError) {
      // Privacy IDs may appear in getChats even when history is stored under the canonical phone JID.
      // Resolve and retry through engine-neutral methods; the adapter remains untouched.
      try {
        const phone = await this.resolveChatPhone(sessionId, engine, chatId);
        const canonicalChatId = phone ? await engine.getNumberId(phone) : null;
        if (canonicalChatId && canonicalChatId !== chatId) {
          const history = await engine.getChatHistory(canonicalChatId, safeLimit, includeMedia);
          return this.sessionService.persistHistory(sessionId, history, chatId);
        }
      } catch {
        // Preserve the original history error, which is more useful to the API caller.
      }
      throw originalError;
    }
  }

  private async resolveChatPhone(sessionId: string, engine: IWhatsAppEngine, chatId: string): Promise<string | null> {
    const privacyIdDigits = chatId.endsWith('@lid') ? chatId.split('@')[0].replace(/\D/g, '') : '';
    const sessionPhone = ((await this.sessionService.findOne(sessionId).catch(() => null))?.phone ?? '').replace(
      /\D/g,
      '',
    );
    const normalizeCandidate = (value?: string | null): string | null => {
      const digits = value?.replace(/\D/g, '') || '';
      if (!digits || digits === privacyIdDigits) {
        return null;
      }
      return digits === sessionPhone ? null : digits;
    };

    // Fast path: scan recent rows from this session before asking the live engine to re-scan
    // WhatsApp state. A failed outgoing row can be newer than the inbound row that carries the
    // canonical contact address, so inspecting only the latest message is not sufficient.
    try {
      const storedMessages = await this.messageRepository.find({
        where: { sessionId, chatId },
        order: { createdAt: 'DESC' },
        take: MessageService.CONTACT_ADDRESS_SCAN_LIMIT,
      });
      for (const storedMessage of storedMessages) {
        const senderPhone = storedMessage.metadata?.senderPhone;
        const candidates = [
          typeof senderPhone === 'string' || typeof senderPhone === 'number' ? String(senderPhone) : null,
          typeof storedMessage.metadata?.author === 'string' ? storedMessage.metadata.author : null,
          storedMessage.from,
          storedMessage.to,
        ];

        for (const candidate of candidates) {
          const storedPhone = normalizeCandidate(candidate);
          if (storedPhone) return storedPhone;
        }
      }
    } catch {
      // Preserve the live engine resolution path below when the local cache lookup fails.
    }

    try {
      const resolved = normalizeCandidate(await engine.resolveContactPhone(chatId));
      if (resolved) return resolved;
    } catch {
      // Fall through to the contact cache, which may still expose a canonical number.
    }

    try {
      const contact = await engine.getContactById(chatId);
      return normalizeCandidate(contact?.number);
    } catch {
      return null;
    }
  }

  // ========== Delete Message ==========

  async editMessage(sessionId: string, dto: { chatId: string; messageId: string; text: string }): Promise<void> {
    const engine = this.getEngine(sessionId);
    if (!engine.editMessage) {
      throw new BadRequestException('The active WhatsApp engine does not support message editing');
    }

    await engine.editMessage(dto.chatId, dto.messageId, dto.text);
    const message = await this.messageRepository.findOne({ where: { sessionId, waMessageId: dto.messageId } });
    if (!message) return;
    message.body = dto.text;
    message.metadata = { ...(message.metadata || {}), editedAt: new Date().toISOString() };
    await this.messageRepository.save(message);
  }

  async deleteMessage(
    sessionId: string,
    dto: { chatId: string; messageId: string; forEveryone?: boolean },
  ): Promise<void> {
    const engine = this.getEngine(sessionId);
    await engine.deleteMessage(dto.chatId, dto.messageId, dto.forEveryone ?? true);

    // Flag the stored message as revoked. No localized display string is persisted here;
    // the dashboard renders the localized "message deleted" text.
    try {
      await this.messageRepository.update({ sessionId, waMessageId: dto.messageId }, { body: '', type: 'revoked' });
    } catch (err) {
      this.logger.warn(`Failed to flag deleted message ${dto.messageId} as revoked`, { error: String(err) });
    }
  }

  private getEngine(sessionId: string) {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new EngineNotReadyError(WHATSAPP_SESSION_DISCONNECTED_MESSAGE);
    }
    if (engine.getStatus() !== EngineStatus.READY) {
      throw new EngineNotReadyError(WHATSAPP_SESSION_DISCONNECTED_MESSAGE);
    }
    return engine;
  }

  private async resolveSendChatId(sessionId: string, engine: IWhatsAppEngine, chatId: string): Promise<string> {
    if (!chatId.endsWith('@lid')) return chatId;

    const phone = await this.resolveChatPhone(sessionId, engine, chatId);
    if (!phone) return chatId;

    try {
      return (await engine.getNumberId(phone)) || chatId;
    } catch {
      return chatId;
    }
  }

  /**
   * Humanising delay: show the engine's typing indicator and pause for a length-scaled, jittered
   * interval before the real send, so automated single sends don't look instantaneous (anti-ban).
   * ON by default — set `SIMULATE_TYPING=false` to disable. Engine-agnostic (goes through
   * `sendChatState`) and strictly best-effort — it never throws and never blocks the send if presence
   * fails or the engine has no presence concept. `SIMULATE_TYPING_MAX_MS` (default 5000) caps the pause.
   * Note: this covers single sends only; bulk sends use their own `delayBetweenMessages` throttle.
   */
  private async simulateTypingIfEnabled(engine: IWhatsAppEngine, chatId: string, text: string): Promise<void> {
    if (process.env.SIMULATE_TYPING === 'false') return;
    try {
      await engine.sendChatState(chatId, 'typing');
      const maxMs = Number(process.env.SIMULATE_TYPING_MAX_MS) || 5000;
      const planned = Math.min(maxMs, 500 + text.length * 45);
      const jittered = Math.round(planned * (0.85 + Math.random() * 0.3)); // ±15% so it isn't metronomic
      await new Promise(resolve => setTimeout(resolve, jittered));
    } catch (error) {
      this.logger.warn(`simulateTyping skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Map a blocked outbound media fetch (SSRF guard) to an HTTP 400 so a
   * caller-supplied internal/unsafe URL returns a client error instead of a 500.
   * All other errors pass through unchanged.
   */
  private toClientFacingError(error: unknown): unknown {
    if (error instanceof SsrfBlockedError) {
      return new BadRequestException(error.message);
    }
    if (error instanceof HttpException) {
      return error;
    }
    return error;
  }

  private buildMediaInput(dto: SendMediaMessageDto): MediaInput {
    if (!dto.url && !dto.base64) {
      throw new BadRequestException('Either url or base64 must be provided');
    }

    if (dto.base64 && !dto.mimetype) {
      throw new BadRequestException('mimetype is required when using base64 data');
    }

    return {
      mimetype: dto.mimetype || 'application/octet-stream',
      data: dto.url || dto.base64!,
      filename: dto.filename,
      caption: dto.caption,
    };
  }
}
