import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AuthService } from '../auth.service';
import { ApiKeyRole } from '../entities/api-key.entity';
import { REQUIRED_ROLE_KEY, PUBLIC_KEY, SKIP_API_KEY_KEY } from '../decorators/auth.decorators';
import { resolveClientIp } from '../../../common/utils/ip';
import { OmegaUserRole } from '../../omega/entities/omega.enums';
import { OmegaAuthService } from '../../omega/omega-auth.service';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly omegaAuthService: OmegaAuthService,
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    const skipApiKey = this.reflector.getAllAndOverride<boolean>(SKIP_API_KEY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic || skipApiKey) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const clientIp = this.getClientIp(request);
    const authHeader = request.headers['authorization'];
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7).trim() : undefined;
    const xApiKey = this.extractXApiKey(request);

    const requiredRole = this.reflector.getAllAndOverride<ApiKeyRole>(REQUIRED_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (xApiKey) {
      return this.authorizeApiKey(request, xApiKey, clientIp, requiredRole);
    }

    if (bearerToken) {
      try {
        const { user } = await this.omegaAuthService.validateSessionToken(bearerToken);
        if (!this.isOmegaAdmin(user.role)) {
          throw new ForbiddenException('This Aurora account does not have admin panel access');
        }

        const syntheticApiKey = {
          id: `omega:${user.id}`,
          name: user.fullName,
          keyHash: '',
          keyPrefix: 'omega-session',
          role: ApiKeyRole.ADMIN,
          allowedIps: null,
          allowedSessions: null,
          isActive: true,
          expiresAt: null,
          lastUsedAt: user.lastLoginAt ?? null,
          usageCount: 0,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        };

        if (requiredRole && !this.authService.hasPermission(syntheticApiKey, requiredRole)) {
          throw new ForbiddenException(`Insufficient permissions. Required: ${requiredRole}`);
        }

        (
          request as Request & {
            apiKey: typeof syntheticApiKey;
            omegaUser: typeof user;
            omegaToken: string;
          }
        ).apiKey = syntheticApiKey;
        (request as Request & { omegaUser: typeof user }).omegaUser = user;
        (request as Request & { omegaToken: string }).omegaToken = bearerToken;

        return true;
      } catch (error) {
        if (error instanceof ForbiddenException) {
          throw error;
        }

        return this.authorizeApiKey(request, bearerToken, clientIp, requiredRole);
      }
    }

    throw new UnauthorizedException('API key or Aurora session is required');
  }

  private async authorizeApiKey(
    request: Request,
    rawKey: string,
    clientIp: string,
    requiredRole?: ApiKeyRole,
  ): Promise<boolean> {
    const sessionId = (request.params['sessionId'] || request.params['id']) as string | undefined;
    const apiKey = await this.authService.validateApiKey(rawKey, clientIp, sessionId);

    if (requiredRole && !this.authService.hasPermission(apiKey, requiredRole)) {
      throw new ForbiddenException(`Insufficient permissions. Required: ${requiredRole}`);
    }

    (request as Request & { apiKey: typeof apiKey }).apiKey = apiKey;

    return true;
  }

  private extractXApiKey(request: Request): string | undefined {
    const xApiKey = request.headers['x-api-key'] as string | undefined;
    return xApiKey?.trim() || undefined;
  }

  private isOmegaAdmin(role: OmegaUserRole): boolean {
    return role === OmegaUserRole.SUPER_ADMIN || role === OmegaUserRole.SUPPORT_ADMIN;
  }

  /**
   * Resolve the real client IP used for the API key's allowedIps whitelist.
   *
   * X-Forwarded-For is client-controllable, so it is only honored when the
   * request actually arrives from a configured trusted proxy (TRUSTED_PROXIES).
   * With no trusted proxies configured, the header is ignored entirely and the
   * direct socket address is used — preventing IP-whitelist spoofing.
   */
  private getClientIp(request: Request): string {
    const trustedProxies = this.configService.get<string[]>('security.trustedProxies') ?? [];
    return resolveClientIp(request, trustedProxies);
  }
}
