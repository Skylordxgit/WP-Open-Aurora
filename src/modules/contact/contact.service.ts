import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SessionService } from '../session/session.service';
import { EngineStatus, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { SavedContact } from './entities/saved-contact.entity';
import { SaveContactsDto } from './dto/saved-contact.dto';
import { Message } from '../message/entities/message.entity';
import { ChatSnapshot } from '../session/entities/chat-snapshot.entity';
import { MediaArchiveService } from '../../common/media/media-archive.service';

/**
 * Owns engine access for contact operations so the "session not started" guard and
 * contact business rules (not-found mapping) live behind the service boundary.
 */
@Injectable()
export class ContactService {
  constructor(
    private readonly sessionService: SessionService,
    @InjectRepository(SavedContact, 'data')
    private readonly savedContactRepository: Repository<SavedContact>,
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(ChatSnapshot, 'data')
    private readonly chatSnapshotRepository: Repository<ChatSnapshot>,
    private readonly mediaArchiveService: MediaArchiveService,
  ) {}

  private getEngine(sessionId: string): IWhatsAppEngine {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException('Session is not started');
    }
    return engine;
  }

  async getContacts(sessionId: string) {
    const engine = this.sessionService.getEngine(sessionId);
    if (engine?.getStatus() === EngineStatus.READY) {
      try {
        const contacts = await engine.getContacts();
        await this.saveContacts(sessionId, {
          contacts: contacts
            .map(contact => ({
              number: this.normalizePhoneCandidate(contact.number, contact.id),
              name: contact.name || contact.pushName,
              source: 'session' as const,
            }))
            .filter(contact => Boolean(contact.number)),
        });
        return contacts;
      } catch {
        // The database fallback below remains available while WhatsApp reconnects.
      }
    }

    const saved = await this.listSavedContacts(sessionId);
    return saved.map(contact => ({
      id: `${this.normalizeDigits(contact.number)}@c.us`,
      number: this.normalizeDigits(contact.number),
      name: contact.name || undefined,
      isMyContact: true,
      isBlocked: false,
    }));
  }

  async getContactById(sessionId: string, contactId: string) {
    const engine = this.sessionService.getEngine(sessionId);
    if (engine?.getStatus() === EngineStatus.READY) {
      try {
        const contact = await engine.getContactById(contactId);
        if (contact) return contact;
      } catch {
        // Resolve from persisted contact/chat identity below.
      }
    }

    const [resolved] = await this.resolveContacts(sessionId, [contactId]);
    if (!resolved?.phone && !resolved?.name) {
      throw new NotFoundException(`Contact ${contactId} not found`);
    }
    return {
      id: contactId,
      number: resolved.phone || '',
      name: resolved.name || undefined,
      isMyContact: Boolean(resolved.name),
      isBlocked: false,
    };
  }

  checkNumberExists(sessionId: string, number: string) {
    return this.getEngine(sessionId).checkNumberExists(number);
  }

  getNumberId(sessionId: string, number: string) {
    return this.getEngine(sessionId).getNumberId(number);
  }

  async resolveContactPhone(sessionId: string, contactId: string): Promise<string | null> {
    const [resolved] = await this.resolveContacts(sessionId, [contactId]);
    return resolved?.phone || null;
  }

  async resolveContacts(sessionId: string, contactIds: string[]) {
    const uniqueIds = [...new Set(contactIds.map(id => id.trim()).filter(Boolean))];
    const engine = this.sessionService.getEngine(sessionId);
    const engineReady = engine?.getStatus() === EngineStatus.READY;
    const [savedContacts, storedMessages, snapshots] = await Promise.all([
      this.listSavedContacts(sessionId),
      uniqueIds.length > 0
        ? this.messageRepository.find({
            where: { sessionId, chatId: In(uniqueIds) },
            order: { timestamp: 'DESC', createdAt: 'DESC' },
            take: Math.min(Math.max(uniqueIds.length * 10, 50), 1000),
          })
        : Promise.resolve([]),
      uniqueIds.length > 0
        ? this.chatSnapshotRepository.find({ where: { sessionId, chatId: In(uniqueIds) } })
        : Promise.resolve([]),
    ]);

    let engineContacts: Awaited<ReturnType<IWhatsAppEngine['getContacts']>> = [];
    try {
      if (engineReady && engine) engineContacts = await engine.getContacts();
    } catch {
      // Phone resolution below can still succeed when the contact-list cache is unavailable.
    }

    const contactsById = new Map(engineContacts.map(contact => [contact.id, contact]));
    const contactsByNumber = new Map<string, (typeof engineContacts)[number]>();
    for (const contact of engineContacts) {
      const number = this.normalizeDigits(contact.number);
      if (number) contactsByNumber.set(number, contact);
    }
    const savedByNumber = new Map<string, SavedContact>();
    for (const contact of savedContacts) {
      const number = this.normalizeDigits(contact.number);
      if (number) savedByNumber.set(number, contact);
    }
    const snapshotsById = new Map(snapshots.map(snapshot => [snapshot.chatId, snapshot]));
    const storedIdentityById = new Map<string, { phone: string | null; name: string | null }>();
    for (const message of storedMessages) {
      const metadata = message.metadata as
        | { senderPhone?: unknown; contact?: { name?: unknown; pushName?: unknown } }
        | undefined;
      const existing = storedIdentityById.get(message.chatId);
      const phone = this.normalizePhoneCandidate(metadata?.senderPhone, message.chatId);
      const contactName =
        (typeof metadata?.contact?.name === 'string' && metadata.contact.name.trim()) ||
        (typeof metadata?.contact?.pushName === 'string' && metadata.contact.pushName.trim()) ||
        null;
      if (!existing || (!existing.phone && phone) || (!existing.name && contactName)) {
        storedIdentityById.set(message.chatId, {
          phone: existing?.phone || phone,
          name: existing?.name || contactName,
        });
      }
    }
    const resolved: Array<{ contactId: string; phone: string | null; name: string | null }> = [];

    // Small batches avoid flooding the WhatsApp page context while still resolving a full inbox quickly.
    for (let index = 0; index < uniqueIds.length; index += 4) {
      const batch = uniqueIds.slice(index, index + 4);
      const batchResults = await Promise.all(
        batch.map(async contactId => {
          const directContact = contactsById.get(contactId);
          const storedIdentity = storedIdentityById.get(contactId);
          const snapshot = snapshotsById.get(contactId);
          let phone =
            this.normalizePhoneCandidate(snapshot?.contactPhone, contactId) ||
            storedIdentity?.phone ||
            this.normalizePhoneCandidate(directContact?.number, contactId) ||
            this.phoneFromDirectContactId(contactId) ||
            null;
          if (engineReady && engine) {
            try {
              phone = this.normalizePhoneCandidate(await engine.resolveContactPhone(contactId), contactId) || phone;
            } catch {
              // Contact/message metadata can still contain a verified phone alias.
            }
          }

          const normalizedPhone =
            phone || this.normalizePhoneCandidate(directContact?.number, contactId) || storedIdentity?.phone || '';
          const phoneContact = normalizedPhone ? contactsByNumber.get(normalizedPhone) : undefined;
          const savedContact = normalizedPhone ? savedByNumber.get(normalizedPhone) : undefined;
          const snapshotName = snapshot?.name?.trim();
          const savedName =
            savedContact?.name?.trim() ||
            (snapshotName && snapshotName !== contactId && !snapshotName.includes('@') ? snapshotName : null) ||
            directContact?.name?.trim() ||
            phoneContact?.name?.trim() ||
            null;
          const fallbackName =
            directContact?.pushName?.trim() || phoneContact?.pushName?.trim() || storedIdentity?.name || null;
          const name = savedName || fallbackName;

          return { contactId, phone: normalizedPhone || null, name };
        }),
      );
      resolved.push(...batchResults);
    }

    await this.persistResolvedContacts(sessionId, resolved, snapshotsById);
    return resolved;
  }

  private async persistResolvedContacts(
    sessionId: string,
    resolved: Array<{ contactId: string; phone: string | null; name: string | null }>,
    snapshotsById: Map<string, ChatSnapshot>,
  ): Promise<void> {
    const identities = resolved.filter(contact => contact.phone || contact.name);
    if (identities.length === 0) return;

    const snapshots: ChatSnapshot[] = [];
    for (const identity of identities) {
      const snapshot =
        snapshotsById.get(identity.contactId) ??
        this.chatSnapshotRepository.create({
          sessionId,
          chatId: identity.contactId,
          name: identity.name || identity.phone || identity.contactId,
          isGroup: false,
          unreadCount: 0,
          timestamp: 0,
          lastMessage: null,
          contactPhone: identity.phone,
        });
      snapshot.contactPhone = identity.phone || snapshot.contactPhone;
      if (identity.name) snapshot.name = identity.name;
      snapshots.push(snapshot);
      snapshotsById.set(identity.contactId, snapshot);
    }
    await this.chatSnapshotRepository.save(snapshots);

    const contacts = identities
      .filter(identity => Boolean(identity.phone))
      .map(identity => ({ number: identity.phone!, name: identity.name || undefined, source: 'session' as const }));
    if (contacts.length > 0) {
      await this.saveContacts(sessionId, { contacts });
    }
  }

  private normalizePhoneCandidate(value: unknown, contactId: string): string {
    if (typeof value !== 'string') return '';
    const digits = this.normalizeDigits(value);
    if (!digits) return '';

    // A LID's numeric user part is a privacy identifier, not a callable phone number.
    const privacyIdDigits = contactId.endsWith('@lid') ? this.normalizeDigits(contactId.split('@')[0]) : '';
    return privacyIdDigits && digits === privacyIdDigits ? '' : digits;
  }

  private phoneFromDirectContactId(contactId: string): string {
    if (!contactId.endsWith('@c.us') && !contactId.endsWith('@s.whatsapp.net')) return '';
    return this.normalizeDigits(contactId.split('@')[0]);
  }

  async getProfilePicture(sessionId: string, contactId: string): Promise<string | null> {
    let snapshot = await this.chatSnapshotRepository.findOne({ where: { sessionId, chatId: contactId } });
    const engine = this.sessionService.getEngine(sessionId);

    if (engine?.getStatus() === EngineStatus.READY) {
      try {
        const url = await engine.getProfilePicture(contactId);
        if (url) {
          try {
            const archived = await this.mediaArchiveService.archiveMedia(sessionId, `profile:${contactId}`, 1, {
              mimetype: 'image/jpeg',
              url,
            });
            snapshot =
              snapshot ??
              this.chatSnapshotRepository.create({
                sessionId,
                chatId: contactId,
                name: contactId,
                isGroup: contactId.endsWith('@g.us'),
                unreadCount: 0,
                timestamp: 0,
                lastMessage: null,
                contactPhone: this.phoneFromDirectContactId(contactId) || null,
                profilePicPath: null,
                profilePicMimetype: null,
              });
            snapshot.profilePicPath = archived.storagePath;
            snapshot.profilePicMimetype = archived.mimetype;
            await this.chatSnapshotRepository.save(snapshot);
          } catch {
            // A transient archive failure must not hide the still-valid live profile URL.
          }
          return url;
        }
      } catch {
        // Serve the last archived image while WhatsApp is reconnecting.
      }
    }

    if (!snapshot?.profilePicPath) return null;
    try {
      const data = await this.mediaArchiveService.read(snapshot.profilePicPath);
      return `data:${snapshot.profilePicMimetype || 'image/jpeg'};base64,${data.toString('base64')}`;
    } catch {
      return null;
    }
  }

  blockContact(sessionId: string, contactId: string) {
    return this.getEngine(sessionId).blockContact(contactId);
  }

  unblockContact(sessionId: string, contactId: string) {
    return this.getEngine(sessionId).unblockContact(contactId);
  }

  listSavedContacts(sessionId: string) {
    return this.savedContactRepository.find({
      where: { sessionId },
      order: { createdAt: 'DESC' },
    });
  }

  async saveContacts(sessionId: string, dto: SaveContactsDto) {
    const existing = await this.savedContactRepository.find({ where: { sessionId } });
    const byNumber = new Map(existing.map(contact => [this.normalizeNumber(contact.number), contact]));

    const next: SavedContact[] = [];

    for (const item of dto.contacts) {
      const normalized = this.normalizeNumber(item.number);
      if (!normalized) continue;

      const current = byNumber.get(normalized) ?? this.savedContactRepository.create({ sessionId, number: normalized });
      current.name = item.name?.trim() || current.name || null;
      current.number = normalized;
      current.source = item.source ?? current.source ?? 'imported';
      next.push(current);
      byNumber.set(normalized, current);
    }

    if (next.length === 0) {
      return [];
    }

    await this.savedContactRepository.save(next);
    return this.listSavedContacts(sessionId);
  }

  async deleteSavedContact(sessionId: string, id: string) {
    const contact = await this.savedContactRepository.findOne({ where: { id, sessionId } });
    if (!contact) {
      throw new NotFoundException(`Saved contact ${id} not found`);
    }
    await this.savedContactRepository.remove(contact);
    return { success: true };
  }

  async clearSavedContacts(sessionId: string) {
    await this.savedContactRepository.delete({ sessionId });
    return { success: true };
  }

  private normalizeNumber(value: string) {
    return value.replace(/[^0-9+@._-]/g, '').trim();
  }

  private normalizeDigits(value: string) {
    return value.replace(/\D/g, '');
  }
}
