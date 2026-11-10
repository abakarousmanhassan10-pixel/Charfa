import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AppEnv, InjectEnv } from '../config';
import { CurrentUser, Public, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { requestMeta } from '../common/request-meta';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, type IssuedTokens } from './auth.service';
import { CSRF_HEADER, CsrfGuard } from './csrf.guard';
import { AuthResponse, AuthUserResponse, LoginDto, RegisterDto } from './dto/auth.dto';

export const REFRESH_COOKIE = 'aima_rt';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** Auth endpoints get a stricter rate limit than the global default. */
const authThrottle = () => ({ default: { limit: Number(process.env.AUTH_THROTTLE_LIMIT ?? 10), ttl: 60_000 } });

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  @Public()
  @Throttle(authThrottle())
  @Post('register')
  @ApiOkResponse({ type: AuthResponse })
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.register(dto, requestMeta(req)));
  }

  @Public()
  @Throttle(authThrottle())
  @Post('login')
  @HttpCode(200)
  @ApiOkResponse({ type: AuthResponse })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.login(dto, requestMeta(req)));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseGuards(CsrfGuard)
  @Post('refresh')
  @HttpCode(200)
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'Must be "1"' })
  @ApiOkResponse({ type: AuthResponse })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      return this.respond(res, await this.auth.refresh(req.cookies?.[REFRESH_COOKIE], requestMeta(req)));
    } catch (err) {
      const code = (err as { response?: { code?: string } }).response?.code;
      if (code !== 'REFRESH_RACE') this.clearCookie(res);
      throw err;
    }
  }

  @Public()
  @UseGuards(CsrfGuard)
  @Post('logout')
  @HttpCode(204)
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'Must be "1"' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE], undefined, requestMeta(req));
    this.clearCookie(res);
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logoutAll(user.id, requestMeta(req));
    this.clearCookie(res);
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOkResponse({ type: AuthUserResponse })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<AuthUserResponse> {
    const record = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    return AuthService.toUserResponse(record);
  }

  private get secureCookies() {
    return this.env.COOKIE_SECURE ?? this.env.NODE_ENV === 'production';
  }

  private respond(res: Response, tokens: IssuedTokens): AuthResponse {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      expires: tokens.refreshTokenExpiresAt,
    });
    res.setHeader('Cache-Control', 'no-store');
    return { accessToken: tokens.accessToken, accessTokenExpiresIn: tokens.accessTokenExpiresIn, user: tokens.user };
  }

  private clearCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    });
  }
}
