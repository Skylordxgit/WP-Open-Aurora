import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { resolveClientIp } from '../../../common/utils/ip';
import { AuthService } from '../../auth/auth.service';
import { ApiKeyRole } from '../../auth/entities/api-key.entity';
import { OmegaUser, OmegaUserRole, OmegaUserStatus } from '../entities';
import { OmegaAuthService } from '../omega-auth.service';

@Injectable()
export class OmegaAuthGuard implements CanActivate {
  constructor(
    private readonly omegaAuthService: OmegaAuthService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { omegaUser?: unknown; omegaToken?: string }>();
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;

    if (token) {
      const session = await this.omegaAuthService.validateSessionToken(token);
      request.omegaUser = session.user;
      request.omegaToken = token;
      return true;
    }

    const apiKeyHeader = this.extractApiKey(request);
    if (!apiKeyHeader) {
      throw new UnauthorizedException('Omega admin token or OpenWA admin API key is required');
    }

    const trustedProxies = this.configService.get<string[]>('security.trustedProxies') ?? [];
    const clientIp = resolveClientIp(request, trustedProxies);
    const apiKey = await this.authService.validateApiKey(apiKeyHeader, clientIp);

    if (!this.authService.hasPermission(apiKey, ApiKeyRole.ADMIN)) {
      throw new ForbiddenException('OpenWA admin API key is required for this resource');
    }

    request.omegaUser = {
      id: `openwa:${apiKey.id}`,
      fullName: apiKey.name,
      email: 'openwa-admin@local',
      passwordHash: '',
      clientId: null,
      role: OmegaUserRole.SUPER_ADMIN,
      status: OmegaUserStatus.ACTIVE,
      lastLoginAt: apiKey.lastUsedAt ?? null,
      createdAt: apiKey.createdAt,
      updatedAt: apiKey.updatedAt,
    } satisfies OmegaUser;

    return true;
  }

  private extractApiKey(request: Request): string | undefined {
    const xApiKey = request.headers['x-api-key'] as string | undefined;
    return xApiKey?.trim() || undefined;
  }
}
