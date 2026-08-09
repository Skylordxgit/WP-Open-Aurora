import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { SkipApiKeyAuth } from '../auth/decorators/auth.decorators';
import { CurrentOmegaUser } from './decorators/omega-auth.decorators';
import { OmegaLoginDto } from './dto';
import { OmegaUser } from './entities';
import { OmegaAuthGuard } from './guards/omega-auth.guard';
import { OmegaAuthService } from './omega-auth.service';

@ApiTags('omega-auth')
@Controller('omega/auth')
@SkipApiKeyAuth()
export class OmegaAuthController {
  constructor(private readonly omegaAuthService: OmegaAuthService) {}

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
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      clientId: user.clientId,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
    };
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
