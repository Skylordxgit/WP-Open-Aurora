import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Request } from 'express';
import { OmegaUserRole } from '../entities';
import { OmegaUser } from '../entities/omega-user.entity';

export const OMEGA_ROLES_KEY = 'omegaRoles';

export const RequireOmegaRoles = (...roles: OmegaUserRole[]) => SetMetadata(OMEGA_ROLES_KEY, roles);

export const CurrentOmegaUser = createParamDecorator((data: unknown, ctx: ExecutionContext): OmegaUser | undefined => {
  const request = ctx.switchToHttp().getRequest<Request & { omegaUser?: OmegaUser }>();
  return request.omegaUser;
});
