import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SavedContact } from '../contact/entities/saved-contact.entity';

export interface ResolvedContact {
  /** Best human-facing display value: saved contact name, else phone digits, else null. */
  displayName: string | null;
  /** Resolved phone number digits, or null when unknown (e.g. unresolved @lid). */
  phone: string | null;
}

export interface ResolveInput {
  sessionId: string;
  chatId: string;
  savedMap: Map<string, Map<string, string>>;
  /** Phone persisted on the message (e.g. resolved @lid senderPhone). */
  metaPhone?: string | null;
  /** Name/phone from a live engine lookup, when available. */
  engineName?: string | null;
  enginePhone?: string | null;
}

/**
 * Single backend authority for turning a WhatsApp chat id into a real contact
 * (saved name → phone), shared by the chat list and dashboard analytics so the
 * resolution logic is never duplicated. Never returns a raw LID as a name: an
 * unresolvable @lid yields { displayName: null } and the UI shows "Unknown
 * Contact". Pure/stateless apart from the saved-contacts read.
 */
@Injectable()
export class ContactResolverService {
  constructor(
    @InjectRepository(SavedContact, 'data')
    private readonly savedContactRepo: Repository<SavedContact>,
  ) {}

  static digits(value?: string | null): string {
    return (value || '').replace(/\D/g, '');
  }

  static isLid(chatId: string): boolean {
    return chatId.endsWith('@lid');
  }

  static isGroup(chatId: string): boolean {
    return chatId.endsWith('@g.us');
  }

  static isBroadcast(chatId: string): boolean {
    return chatId.endsWith('@broadcast') || chatId === 'status@broadcast';
  }

  /** A phone is only useful if it has digits and isn't the placeholder all-zeros / "0". */
  static isValidPhone(digits: string): boolean {
    return !!digits && !/^0+$/.test(digits);
  }

  /** Load saved contacts into a per-session, digits-keyed name lookup. */
  async loadSavedMap(): Promise<Map<string, Map<string, string>>> {
    const contacts = await this.savedContactRepo.find();
    const bySession = new Map<string, Map<string, string>>();
    for (const ct of contacts) {
      if (!ct.name) continue;
      const digits = ContactResolverService.digits(ct.number);
      if (!digits) continue;
      let map = bySession.get(ct.sessionId);
      if (!map) {
        map = new Map();
        bySession.set(ct.sessionId, map);
      }
      if (!map.has(digits)) map.set(digits, ct.name);
    }
    return bySession;
  }

  /**
   * Resolve one chat to { displayName, phone } using the priority:
   *   1. saved contact name (matched by phone)
   *   2. real phone number
   *   3. null  → caller / UI renders "Unknown Contact"
   * Never produces a raw LID as the display name.
   */
  resolve(input: ResolveInput): ResolvedContact {
    const { sessionId, chatId, savedMap } = input;
    const local = chatId.split('@')[0];
    const savedName = (digits: string): string | null =>
      ContactResolverService.isValidPhone(digits) ? (savedMap.get(sessionId)?.get(digits) ?? null) : null;
    // An engine "name" that is a raw JID or just the chat id's local part (e.g. the
    // bare LID number) is not a real name — reject it so it can't leak as identity.
    const rawEngineName = input.engineName?.trim() || '';
    const engineName = rawEngineName && !rawEngineName.includes('@') && rawEngineName !== local ? rawEngineName : null;

    if (ContactResolverService.isGroup(chatId) || ContactResolverService.isBroadcast(chatId)) {
      // Group/broadcast: only a real engine-supplied name is meaningful; no phone.
      return { displayName: engineName, phone: null };
    }

    if (ContactResolverService.isLid(chatId)) {
      // Privacy id: the LID itself is never a contact identity. Resolve via the
      // persisted/engine phone, then a saved name for that phone.
      const phone = ContactResolverService.digits(input.metaPhone || input.enginePhone || '');
      const valid = ContactResolverService.isValidPhone(phone);
      const name = savedName(phone) ?? engineName;
      return { displayName: name ?? (valid ? phone : null), phone: valid ? phone : null };
    }

    // Direct chat (@c.us / @s.whatsapp.net): the local part is the phone number.
    const phone = ContactResolverService.digits(local);
    if (!ContactResolverService.isValidPhone(phone)) {
      return { displayName: engineName, phone: null };
    }
    const name = savedName(phone) ?? engineName;
    return { displayName: name ?? phone, phone };
  }
}
