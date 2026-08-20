import { BadRequestException } from '@nestjs/common';

/** The engine definitively could not map a WhatsApp recipient to a sendable address. */
export class RecipientUnreachableError extends BadRequestException {
  constructor() {
    super(
      'WhatsApp could not resolve this contact to a sendable phone number. ' +
        'Wait for synchronization and try again.',
    );
  }
}
