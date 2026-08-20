import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionService } from '../session/session.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { SavedContact } from './entities/saved-contact.entity';
import { SaveContactsDto } from './dto/saved-contact.dto';

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
  ) {}

  private getEngine(sessionId: string): IWhatsAppEngine {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException('Session is not started');
    }
    return engine;
  }

  getContacts(sessionId: string) {
    return this.getEngine(sessionId).getContacts();
  }

  async getContactById(sessionId: string, contactId: string) {
    const contact = await this.getEngine(sessionId).getContactById(contactId);
    if (!contact) {
      throw new NotFoundException(`Contact ${contactId} not found`);
    }
    return contact;
  }

  checkNumberExists(sessionId: string, number: string) {
    return this.getEngine(sessionId).checkNumberExists(number);
  }

  getNumberId(sessionId: string, number: string) {
    return this.getEngine(sessionId).getNumberId(number);
  }

  resolveContactPhone(sessionId: string, contactId: string) {
    return this.getEngine(sessionId).resolveContactPhone(contactId);
  }

  async resolveContacts(sessionId: string, contactIds: string[]) {
    const engine = this.getEngine(sessionId);
    const uniqueIds = [...new Set(contactIds.map(id => id.trim()).filter(Boolean))];
    const savedContacts = await this.listSavedContacts(sessionId);

    let engineContacts: Awaited<ReturnType<IWhatsAppEngine['getContacts']>> = [];
    try {
      engineContacts = await engine.getContacts();
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
    const resolved: Array<{ contactId: string; phone: string | null; name: string | null }> = [];

    // Small batches avoid flooding the WhatsApp page context while still resolving a full inbox quickly.
    for (let index = 0; index < uniqueIds.length; index += 4) {
      const batch = uniqueIds.slice(index, index + 4);
      const batchResults = await Promise.all(
        batch.map(async contactId => {
          const directContact = contactsById.get(contactId);
          let phone: string | null = null;
          try {
            phone = await engine.resolveContactPhone(contactId);
          } catch {
            phone = null;
          }

          const normalizedPhone = this.normalizeDigits(phone || '');
          const phoneContact = normalizedPhone ? contactsByNumber.get(normalizedPhone) : undefined;
          const savedContact = normalizedPhone ? savedByNumber.get(normalizedPhone) : undefined;
          const name =
            savedContact?.name?.trim() ||
            directContact?.name?.trim() ||
            directContact?.pushName?.trim() ||
            phoneContact?.name?.trim() ||
            phoneContact?.pushName?.trim() ||
            null;

          return { contactId, phone: normalizedPhone || null, name };
        }),
      );
      resolved.push(...batchResults);
    }

    return resolved;
  }

  getProfilePicture(sessionId: string, contactId: string) {
    return this.getEngine(sessionId).getProfilePicture(contactId);
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
