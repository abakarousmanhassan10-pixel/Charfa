import { CallHandler, ExecutionContext, Injectable, NestInterceptor, ServiceUnavailableException } from '@nestjs/common';
import { catchError, from, mergeMap, throwError, type Observable } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

const PROVIDER_CODES = new Set(['PROVIDER_UNAVAILABLE', 'CREDENTIALS_REJECTED', 'PROVIDER_NOT_CONFIGURED', 'PROVIDER_NOT_VERIFIED', 'CAPABILITY_UNSUPPORTED']);

/** A provider outage or refusal during a customer action is an incident for the administrators: it is recorded (code only, no detail) and the error continues unchanged. */
@Injectable()
export class ProviderIncidentInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err) => {
        const code = err instanceof ServiceUnavailableException ? (err.getResponse() as { code?: string }).code : undefined;
        const tenant = ctx.switchToHttp().getRequest().tenant as { businessId: string; userId: string } | undefined;
        if (!code || !PROVIDER_CODES.has(code) || !tenant) return throwError(() => err);
        return from(this.prisma.subscriptionAuditLog.create({ data: { businessId: tenant.businessId, actorId: tenant.userId, action: 'provider_unavailable', reason: code, metadata: { route: ctx.getHandler().name } } }).catch(() => undefined)).pipe(mergeMap(() => throwError(() => err)));
      }),
    );
  }
}
