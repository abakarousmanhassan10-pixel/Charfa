import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@touma/database';
import type { Request, Response } from 'express';

/**
 * Uniform error envelope. Internal errors are logged server-side with a request id
 * and never leak stack traces, SQL or provider payloads to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const requestId = (req.headers['x-request-id'] as string) || req.id;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message: string | string[] = 'An unexpected error occurred';
    // Extra fields a service may expose to clients. Anything else in an exception body is dropped.
    const extra: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') message = body;
      else if (body && typeof body === 'object') {
        const b = body as { message?: string | string[]; code?: string; error?: string; generationId?: unknown; usage?: unknown; issues?: unknown; conflicts?: unknown; missing?: unknown; planId?: unknown; recurrenceId?: unknown; existingId?: unknown };
        message = b.message ?? exception.message;
        for (const k of ['generationId', 'usage', 'issues', 'conflicts', 'missing', 'planId', 'recurrenceId', 'existingId'] as const) if (b[k] !== undefined) extra[k] = b[k];
        code = b.code ?? (b.error ? b.error.toUpperCase().replace(/\s+/g, '_') : code);
      }
      if (code === 'INTERNAL_ERROR') code = HttpStatus[status] ?? 'ERROR';
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2002') {
      status = HttpStatus.CONFLICT;
      code = 'CONFLICT';
      message = 'Resource already exists';
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2025') {
      status = HttpStatus.NOT_FOUND;
      code = 'NOT_FOUND';
      message = 'Resource not found';
    }

    if (status >= 500) {
      this.logger.error(
        `[${requestId ?? '-'}] ${req.method} ${req.originalUrl ?? req.url}: ${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
    }

    res.status(status).json({ statusCode: status, code, message, requestId, ...extra });
  }
}
