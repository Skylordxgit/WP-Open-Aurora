import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { extname } from 'path';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../services/logger.service';
import { StorageService } from '../storage/storage.service';
import { loadRemoteMediaBuffer } from './load-remote-media';

export interface ArchivedMedia {
  mimetype: string;
  filename?: string;
  storagePath: string;
}

type MessageMedia = NonNullable<IncomingMessage['media']>;

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
};

@Injectable()
export class MediaArchiveService {
  private readonly logger = createLogger('MediaArchiveService');

  constructor(private readonly storageService: StorageService) {}

  async archiveMessage(sessionId: string, message: IncomingMessage): Promise<IncomingMessage> {
    if (!message.media || message.media.storagePath) return message;

    try {
      const archived = await this.archiveMedia(sessionId, message.id, message.timestamp, message.media);
      return { ...message, media: { ...message.media, ...archived } };
    } catch (error) {
      this.logger.warn(`Could not archive WhatsApp media ${message.id}`, {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return message;
    }
  }

  async archiveMedia(
    sessionId: string,
    messageId: string,
    timestamp: number | undefined,
    media: MessageMedia,
  ): Promise<ArchivedMedia> {
    const loaded = await this.loadMedia(media);
    const mimetype = loaded.mimetype || media.mimetype || 'application/octet-stream';
    const storagePath = this.buildStoragePath(sessionId, messageId, timestamp, mimetype, media.filename);
    await this.storageService.putFile(storagePath, loaded.data);
    return { mimetype, filename: media.filename, storagePath };
  }

  async read(storagePath: string): Promise<Buffer> {
    return this.storageService.getFile(storagePath);
  }

  private async loadMedia(media: MessageMedia): Promise<{ data: Buffer; mimetype: string }> {
    const remoteUrl = media.url || (media.data?.match(/^https?:\/\//i) ? media.data : undefined);
    if (remoteUrl) {
      const loaded = await loadRemoteMediaBuffer(remoteUrl);
      return { data: loaded.data, mimetype: loaded.mimetype || media.mimetype };
    }

    if (!media.data) throw new Error('Media event contained no downloadable data');
    const dataUrl = media.data.match(/^data:([^;,]+)?;base64,(.*)$/s);
    const encoded = dataUrl ? dataUrl[2] : media.data;
    const data = Buffer.from(encoded, 'base64');
    if (data.length === 0) throw new Error('Media event contained empty base64 data');
    return { data, mimetype: dataUrl?.[1] || media.mimetype };
  }

  private buildStoragePath(
    sessionId: string,
    messageId: string,
    timestamp: number | undefined,
    mimetype: string,
    filename?: string,
  ): string {
    const date = new Date(timestamp && timestamp > 0 ? timestamp * 1000 : Date.now());
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const digest = createHash('sha256').update(`${sessionId}:${messageId}`).digest('hex');
    const filenameExtension = filename
      ? extname(filename)
          .toLowerCase()
          .replace(/[^.a-z0-9]/g, '')
      : '';
    const extension = filenameExtension || MIME_EXTENSIONS[mimetype.toLowerCase()] || '';
    return `whatsapp/${safeSession}/${year}/${month}/${digest}${extension}`;
  }
}
