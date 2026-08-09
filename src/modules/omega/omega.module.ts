import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from '../message/entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { SessionModule } from '../session/session.module';
import {
  OmegaAuthSession,
  OmegaCampaign,
  OmegaCampaignRecipient,
  OmegaClient,
  OmegaContact,
  OmegaContactGroup,
  OmegaMessage,
  OmegaPlan,
  OmegaSubscription,
  OmegaUsageLog,
  OmegaUser,
  OmegaWhatsappSession,
} from './entities';
import { OmegaAuthController } from './omega-auth.controller';
import { OmegaAdminController } from './omega-admin.controller';
import { OmegaAdminService } from './omega-admin.service';
import { OmegaAuthService } from './omega-auth.service';
import { OmegaAuthGuard } from './guards/omega-auth.guard';
import { OmegaRolesGuard } from './guards/omega-roles.guard';
import { OpenwaApiClientService } from './openwa-api-client.service';
import { OmegaUsageService } from './omega-usage.service';

@Module({
  imports: [
    SessionModule,
    TypeOrmModule.forFeature(
      [
        OmegaUser,
        OmegaClient,
        OmegaPlan,
        OmegaWhatsappSession,
        OmegaContact,
        OmegaContactGroup,
        OmegaCampaign,
        OmegaCampaignRecipient,
        OmegaMessage,
        OmegaUsageLog,
        OmegaSubscription,
        OmegaAuthSession,
      ],
      'main',
    ),
    TypeOrmModule.forFeature([Session, Message], 'data'),
  ],
  controllers: [OmegaAuthController, OmegaAdminController],
  providers: [
    OmegaAuthService,
    OmegaAdminService,
    OmegaAuthGuard,
    OmegaRolesGuard,
    OpenwaApiClientService,
    OmegaUsageService,
  ],
})
export class OmegaModule {}
