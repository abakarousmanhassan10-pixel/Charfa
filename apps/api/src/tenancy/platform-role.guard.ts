import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlatformRole } from '@touma/shared';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

const PLATFORM_ROLES = 'touma:platformRoles';

@Injectable()
export class PlatformRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<PlatformRole[]>(PLATFORM_ROLES, [context.getHandler(), context.getClass()]);
    const user: AuthenticatedUser | undefined = context.switchToHttp().getRequest().user;
    if (!roles?.length || !user || !roles.includes(user.platformRole)) {
      throw new ForbiddenException({ code: 'PLATFORM_ROLE_REQUIRED', message: 'Administrator access required' });
    }
    return true;
  }
}

/** Platform-level (not tenant) authorization, e.g. for /admin. The role is re-read from the DB on every request. */
export function RequirePlatformRole(...roles: PlatformRole[]) {
  return applyDecorators(SetMetadata(PLATFORM_ROLES, roles), UseGuards(PlatformRoleGuard));
}
