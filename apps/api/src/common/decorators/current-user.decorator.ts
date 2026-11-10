import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export interface AuthenticatedUser {
  id: string;
  email: string;
  platformRole: 'USER' | 'SUPPORT' | 'SUPER_ADMIN';
  sessionId: string;
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedUser => ctx.switchToHttp().getRequest().user,
);

export const IS_PUBLIC = 'isPublic';
/** Marks a route as not requiring an access token. All routes are protected by default. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
