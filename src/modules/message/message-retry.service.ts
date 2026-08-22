import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { MediaArchiveService } from '../../common/media/media-archive.service';
import { createLogger } from '../../common/services/logger.service';
import {
  EngineStatus,
  IWhatsAppEngine,
  MediaInput,
  MessageResult,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { EventsGateway } from '../events/events.gateway';
import { SessionService } from '../session/session.service';
import { Message, MessageStatus } from './entities/message.entity';
import { OutboundRetryPayload, outboundClientMessageId, readOutboundRetryPayload } from './message-retry.types';

@Injectable()
export class MessageRetryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('MessageRetryService');
  private timer?: NodeJS.Timeout;
  private processing = false;

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly sessionService: SessionService,
    private readonly mediaArchiveService: MediaArchiveService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.MESSAGE_RETRY_ENABLED === 'false') return;
    const intervalMs = Math.max(Number(process.env.MESSAGE_RETRY_POLL_MS) || 10_000, 1000);
    this.timer = setInterval(() => void this.processDueMessages(), intervalMs);
    this.timer.unref?.();
    setTimeout(() => void this.processDueMessages(), Math.min(intervalMs, 2000)).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async processDueMessages(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const now = new Date();
      const stalePendingAt = new Date(
        Date.now() - Math.max(Number(process.env.MESSAGE_PENDING_STALE_MS) || 120_000, 30_000),
      );
      const candidates = await this.messageRepository.find({
        where: [
          { status: MessageStatus.FAILED, nextRetryAt: LessThanOrEqual(now) },
          { status: MessageStatus.PENDING, createdAt: LessThanOrEqual(stalePendingAt) },
        ],
        order: { nextRetryAt: 'ASC', createdAt: 'ASC' },
        take: Math.max(Number(process.env.MESSAGE_RETRY_BATCH_SIZE) || 25, 1),
      });

      for (const message of candidates) await this.processMessage(message, now);
    } catch (error) {
      this.logger.error('Failed-message retry scan failed', error instanceof Error ? error.message : String(error));
    } finally {
      this.processing = false;
    }
  }

  private async processMessage(message: Message, now: Date): Promise<void> {
    const retry = readOutboundRetryPayload(message.metadata);
    if (!retry) return;

    if (message.status === MessageStatus.PENDING) {
      message.status = MessageStatus.FAILED;
      message.lastError = message.lastError || 'Recovered an interrupted send after backend restart';
      message.nextRetryAt = now;
      await this.messageRepository.save(message);
    }

    const engine = this.sessionService.getEngine(message.sessionId);
    if (!engine || engine.getStatus() !== EngineStatus.READY) {
      message.nextRetryAt = new Date(Date.now() + 30_000);
      await this.messageRepository.save(message);
      return;
    }

    // nextRetryAt doubles as a short database lease. The conditional update prevents two Aurora
    // replicas from retrying the same row at the same time.
    const leaseUntil = new Date(Date.now() + 120_000);
    const claim = await this.messageRepository.update(
      { id: message.id, status: MessageStatus.FAILED, nextRetryAt: LessThanOrEqual(now) },
      { nextRetryAt: leaseUntil },
    );
    if (!claim.affected) return;

    try {
      const result = await this.send(engine, message, retry);
      const metadata = { ...(message.metadata || {}) };
      Reflect.deleteProperty(metadata, 'retry');
      message.metadata = metadata;
      message.waMessageId = result.id;
      message.timestamp = result.timestamp;
      message.status = MessageStatus.SENT;
      message.nextRetryAt = null;
      message.lastError = null;
      await this.messageRepository.save(message);
      this.eventsGateway.emitMessageAck(message.sessionId, { messageId: message.id, status: 'sent' });
      this.eventsGateway.emitMessageAck(message.sessionId, { messageId: result.id, status: 'sent' });
    } catch (error) {
      const attempts = (message.retryCount || 0) + 1;
      const maxAttempts = Math.max(Number(process.env.MESSAGE_RETRY_MAX_ATTEMPTS) || 5, 1);
      const reason = error instanceof Error ? error.message : String(error);
      message.retryCount = attempts;
      message.status = MessageStatus.FAILED;
      message.lastError = reason.slice(0, 2000);
      message.nextRetryAt =
        attempts >= maxAttempts || this.isPermanentFailure(reason)
          ? null
          : new Date(Date.now() + this.retryDelay(attempts));
      await this.messageRepository.save(message);
      this.eventsGateway.emitMessageAck(message.sessionId, { messageId: message.id, status: 'failed' });
      this.logger.warn(`WhatsApp message retry ${attempts}/${maxAttempts} failed`, {
        sessionId: message.sessionId,
        messageId: message.id,
        reason,
      });
    }
  }

  private async send(engine: IWhatsAppEngine, message: Message, retry: OutboundRetryPayload): Promise<MessageResult> {
    const id = outboundClientMessageId(message.id);
    switch (retry.kind) {
      case 'text':
        return engine.sendTextMessage(retry.chatId, retry.text, id);
      case 'image':
        return engine.sendImageMessage(retry.chatId, await this.mediaInput(message, retry.caption, id));
      case 'video':
        return engine.sendVideoMessage(retry.chatId, await this.mediaInput(message, retry.caption, id));
      case 'audio':
        return engine.sendAudioMessage(retry.chatId, await this.mediaInput(message, retry.caption, id));
      case 'document':
        return engine.sendDocumentMessage(retry.chatId, await this.mediaInput(message, retry.caption, id));
      case 'sticker':
        return engine.sendStickerMessage(retry.chatId, await this.mediaInput(message, retry.caption, id));
      case 'location':
        return engine.sendLocationMessage(retry.chatId, {
          latitude: retry.latitude,
          longitude: retry.longitude,
          description: retry.description,
          address: retry.address,
          clientMessageId: id,
        });
      case 'contact':
        return engine.sendContactMessage(retry.chatId, {
          name: retry.contactName,
          number: retry.contactNumber,
          clientMessageId: id,
        });
      case 'reply':
        return engine.replyToMessage(retry.chatId, retry.quotedMessageId, retry.text, id);
    }
  }

  private async mediaInput(
    message: Message,
    caption: string | undefined,
    clientMessageId: string,
  ): Promise<MediaInput> {
    const metadataMedia =
      message.metadata?.media && typeof message.metadata.media === 'object'
        ? (message.metadata.media as Record<string, unknown>)
        : undefined;
    let data: Buffer | string | undefined;
    if (message.mediaPath) data = await this.mediaArchiveService.read(message.mediaPath);
    if (!data && typeof metadataMedia?.data === 'string') data = metadataMedia.data;
    if (!data && typeof metadataMedia?.url === 'string') data = metadataMedia.url;
    if (!data) throw new Error('Archived media is unavailable for retry');
    return {
      data,
      mimetype:
        message.mediaMimetype ||
        (typeof metadataMedia?.mimetype === 'string' ? metadataMedia.mimetype : 'application/octet-stream'),
      filename: typeof metadataMedia?.filename === 'string' ? metadataMedia.filename : undefined,
      caption,
      clientMessageId,
    };
  }

  private retryDelay(attempt: number): number {
    const base = Math.max(Number(process.env.MESSAGE_RETRY_BASE_DELAY_MS) || 15_000, 1000);
    const delay = Math.min(base * 2 ** Math.min(attempt - 1, 6), 15 * 60_000);
    return Math.round(delay * (0.85 + Math.random() * 0.3));
  }

  private isPermanentFailure(reason: string): boolean {
    return /not registered|not in whatsapp|invalid (number|recipient)|resolve this contact|unsafe media|ssrf|blocked/i.test(
      reason,
    );
  }
}
