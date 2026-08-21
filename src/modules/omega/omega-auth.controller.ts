import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { SkipApiKeyAuth } from '../auth/decorators/auth.decorators';
import { SendTextMessageDto } from '../message/dto';
import { MarkChatReadDto } from '../session/dto';
import { CurrentOmegaUser } from './decorators/omega-auth.decorators';
import { OmegaLoginDto, UpdateOmegaProfileDto } from './dto';
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
    const [companyName, teamName] = await Promise.all([
      this.omegaAdminService.getClientCompanyName(user.clientId),
      this.omegaAdminService.getTeamName(user.teamId),
    ]);
    return {
      token,
      expiresAt,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        clientId: user.clientId,
        teamId: user.teamId,
        companyName,
        workspaceName: companyName,
        teamName,
        status: user.status,
        isOnDuty: user.isOnDuty,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  @Get('me')
  @UseGuards(OmegaAuthGuard)
  async me(@CurrentOmegaUser() user: OmegaUser) {
    const [companyName, teamName] = await Promise.all([
      this.omegaAdminService.getClientCompanyName(user.clientId),
      this.omegaAdminService.getTeamName(user.teamId),
    ]);
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      clientId: user.clientId,
      teamId: user.teamId,
      companyName,
      workspaceName: companyName,
      teamName,
      status: user.status,
      isOnDuty: user.isOnDuty,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
    };
  }

  @Patch('me')
  @UseGuards(OmegaAuthGuard)
  async updateMe(@CurrentOmegaUser() user: OmegaUser, @Body() dto: UpdateOmegaProfileDto) {
    const updatedUser = await this.omegaAuthService.updateProfile(user.id, {
      fullName: dto.fullName,
      password: dto.password,
      isOnDuty: dto.isOnDuty,
    });
    const [companyName, teamName] = await Promise.all([
      this.omegaAdminService.getClientCompanyName(updatedUser.clientId),
      this.omegaAdminService.getTeamName(updatedUser.teamId),
    ]);
    return {
      id: updatedUser.id,
      fullName: updatedUser.fullName,
      email: updatedUser.email,
      role: updatedUser.role,
      clientId: updatedUser.clientId,
      teamId: updatedUser.teamId,
      companyName,
      workspaceName: companyName,
      teamName,
      status: updatedUser.status,
      isOnDuty: updatedUser.isOnDuty,
      mustChangePassword: updatedUser.mustChangePassword,
      lastLoginAt: updatedUser.lastLoginAt,
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
