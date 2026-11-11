import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { BusinessRole } from '@touma/shared';

/**
 * Verified tenant scope for the current request, set ONLY by BusinessAccessGuard after the
 * caller's ACTIVE membership has been confirmed. Services must take businessId from here,
 * never from the request body or query.
 */
export interface TenantContext {
  businessId: string;
  membershipId: string;
  role: BusinessRole;
  userId: string;
}

export const Tenant = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantContext => {
  const tenant = ctx.switchToHttp().getRequest().tenant;
  if (!tenant) throw new Error('Tenant() used on a route without @RequirePermission()');
  return tenant;
});
