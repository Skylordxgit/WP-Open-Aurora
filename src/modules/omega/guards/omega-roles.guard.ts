import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { OMEGA_ROLES_KEY } from '../decorators/omega-auth.decorators';
import { OmegaUser, OmegaUserRole } from '../entities';

@Injectable()
export class OmegaRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<OmegaUserRole[]>(OMEGA_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!roles || roles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { omegaUser?: OmegaUser }>();
    const user = request.omegaUser;
    if (!user) {
      throw new ForbiddenException('Omega user context not found');
    }

    if (!roles.includes(user.role)) {
      throw new ForbiddenException('You do not have permission to access this Omega resource');
    }

    return true;
  }
}
