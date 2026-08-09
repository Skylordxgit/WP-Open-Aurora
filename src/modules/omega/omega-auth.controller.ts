import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { SkipApiKeyAuth } from '../auth/decorators/auth.decorators';
import { SendTextMessageDto } from '../message/dto';
import { MarkChatReadDto } from '../session/dto';
import { CurrentOmegaUser } from './decorators/omega-auth.decorators';
import { OmegaLoginDto } from './dto';
import { OmegaUser } from './entities';
import { OmegaAdminService } from './omega-admin.service';
import { OmegaAuthGuard } from './guards/omega-auth.guard';
import { OmegaAuthService } from './omega-auth.service';

@ApiTags('omega-auth')
@Controller('omega/auth')
@SkipApiKeyAuth()
export class OmegaAuthController {
  constructor(
    private readonly omegaAuthService: OmegaAuthService,
    private readonly omegaAdminService: OmegaAdminService,
  ) {}

  @Post('login')
  async login(@Body() dto: OmegaLoginDto) {
    const { token, user, expiresAt } = await this.omegaAuthService.login(dto.email, dto.password);
    return {
      token,
      expiresAt,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        clientId: user.clientId,
        status: user.status,
      },
    };
  }

  @Get('me')
  @UseGuards(OmegaAuthGuard)
  async me(@CurrentOmegaUser() user: OmegaUser) {
    const companyName = await this.omegaAdminService.getClientCompanyName(user.clientId);
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      clientId: user.clientId,
      companyName,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
    };
  }

  @Get('workspace')
  @UseGuards(OmegaAuthGuard)
  async workspace(@CurrentOmegaUser() user: OmegaUser) {
    return this.omegaAdminService.getWorkspaceForUser(user);
  }

  @Get('workspace/messages/:sessionId/:chatId')
  @UseGuards(OmegaAuthGuard)
  async workspaceMessages(
    @CurrentOmegaUser() user: OmegaUser,
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = Number.parseInt(limit ?? '100', 10);
    const safeLimit = Number.isFinite(parsedLimit) ? parsedLimit : 100;
    return this.omegaAdminService.getWorkspaceMessages(user, sessionId, chatId, safeLimit);
  }

  @Post('workspace/chats/:sessionId/read')
  @UseGuards(OmegaAuthGuard)
  async markWorkspaceChatRead(
    @CurrentOmegaUser() user: OmegaUser,
    @Param('sessionId') sessionId: string,
    @Body() dto: MarkChatReadDto,
  ) {
    const success = await this.omegaAdminService.markWorkspaceChatRead(user, sessionId, dto.chatId);
    return { success };
  }

  @Post('workspace/messages/:sessionId/send-text')
  @UseGuards(OmegaAuthGuard)
  async sendWorkspaceText(
    @CurrentOmegaUser() user: OmegaUser,
    @Param('sessionId') sessionId: string,
    @Body() dto: SendTextMessageDto,
  ) {
    return this.omegaAdminService.sendWorkspaceText(user, sessionId, dto.chatId, dto.text);
  }

  @Post('logout')
  @UseGuards(OmegaAuthGuard)
  async logout(@Req() req: Request & { omegaToken?: string }) {
    if (req.omegaToken) {
      await this.omegaAuthService.logout(req.omegaToken);
    }
    return { success: true };
  }
}
