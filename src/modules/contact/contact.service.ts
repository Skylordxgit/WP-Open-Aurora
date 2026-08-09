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
}
