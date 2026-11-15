import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlanFeature } from '@touma/shared';
import type { Observable } from 'rxjs';
import { EntitlementsService } from './entitlements.service';

const KEY = 'plan:feature';
/** Marks a controller (or route) as part of a plan feature: with BILLING_ENFORCEMENT_ENABLED the server refuses it (402) when the business's plan does not include it. */
export const RequireFeature = (feature: PlanFeature) => SetMetadata(KEY, feature);

/** Runs after the tenant guard (which sets request.tenant), so the business is the verified one, never a value from the request body. */
@Injectable()
export class PlanFeatureInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, private readonly entitlements: EntitlementsService) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const feature = this.reflector.getAllAndOverride<PlanFeature | undefined>(KEY, [ctx.getHandler(), ctx.getClass()]);
    const tenant = ctx.switchToHttp().getRequest().tenant as { businessId: string } | undefined;
    if (feature && tenant) await this.entitlements.assertFeature(tenant.businessId, feature);
    return next.handle();
  }
}
