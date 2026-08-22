import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';
import { SessionModule } from '../session/session.module';
import { SavedContact } from './entities/saved-contact.entity';
import { Message } from '../message/entities/message.entity';
import { ChatSnapshot } from '../session/entities/chat-snapshot.entity';

@Module({
  imports: [SessionModule, TypeOrmModule.forFeature([SavedContact, Message, ChatSnapshot], 'data')],
  controllers: [ContactController],
  providers: [ContactService],
})
export class ContactModule {}
