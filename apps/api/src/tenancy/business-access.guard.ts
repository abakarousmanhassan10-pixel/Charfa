import { CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException, SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiForbiddenResponse, ApiNotFoundResponse, ApiParam } from '@nestjs/swagger';
import type { Request } from 'express';
import { roleHasPermission, type Permission } from '@touma/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import type { TenantContext } from './tenant-context';

export const REQUIRED_PERMISSION = 'touma:requiredPermission';
const ID_PATTERN = /^[a-z0-9]{20,40}$/;

/**
 * Tenant isolation boundary.
 *  1. Reads :businessId from the route.
 *  2. Requires an ACTIVE membership of the authenticated user in a non-deleted business.
 *  3. Requires the route's permission for the member's role.
 * Non-members get 404 (not 403), so the existence of other tenants' ids is never revealed.
 * Platform admins get no implicit access; platform operations live under /admin.
 */
@Injectable()
export class BusinessAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.get<Permission>(REQUIRED_PERMISSION, context.getHandler());
    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser; tenant?: TenantContext }>();
    const businessId = req.params.businessId;
    const user = req.user;
    if (!permission || !user) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Access denied' });

    const notFound = () => new NotFoundException({ code: 'BUSINESS_NOT_FOUND', message: 'Business not found' });
    if (typeof businessId !== 'string' || !ID_PATTERN.test(businessId)) throw notFound();

    const membership = await this.prisma.membership.findFirst({
      where: { businessId, userId: user.id, status: 'ACTIVE', business: { deletedAt: null } },
      select: { id: true, role: true },
    });
    if (!membership) throw notFound();

    if (!roleHasPermission(membership.role, permission)) {
      throw new ForbiddenException({
        code: 'INSUFFICIENT_PERMISSION',
        message: `Your role (${membership.role}) does not allow this action`,
      });
    }

    req.tenant = { businessId, membershipId: membership.id, role: membership.role, userId: user.id };
    return true;
  }
}

/** Protects a /businesses/:businessId/... route with tenant isolation + a permission check. */
export function RequirePermission(permission: Permission) {
  return applyDecorators(
    SetMetadata(REQUIRED_PERMISSION, permission),
    UseGuards(BusinessAccessGuard),
    ApiParam({ name: 'businessId', type: String }),
    ApiNotFoundResponse({ description: 'Business not found or caller is not a member' }),
    ApiForbiddenResponse({ description: `Requires permission ${permission}` }),
  );
}
