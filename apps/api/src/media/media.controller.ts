import { Body, Controller, Delete, Get, Headers, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/current-user.decorator';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { MediaQueryDto, UpdateMediaDto } from './media.dto';
import { MediaService } from './media.service';

@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post()
  @ApiBearerAuth()
  @RequireTenantPermission('media.write')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'JPEG, PNG, WebP, GIF, MP4, MOV or WebM' },
        folder: { type: 'string' },
        altText: { type: 'string' },
      },
    },
  })
  upload(@Tenant() tenant: TenantContext, @Req() req: Request) {
    return this.media.upload(tenant, req);
  }

  @Get()
  @ApiBearerAuth()
  @RequireTenantPermission('media.read')
  list(@Tenant() tenant: TenantContext, @Query() q: MediaQueryDto) {
    return this.media.list(tenant, q);
  }

  @Get('folders')
  @ApiBearerAuth()
  @RequireTenantPermission('media.read')
  folders(@Tenant() tenant: TenantContext) {
    return this.media.folders(tenant);
  }

  /**
   * Media bytes, authorised by an HMAC-signed expiring URL (no bearer token, so <img>/<video> work).
   * The object is streamed from private storage; Range requests are supported for video playback.
   */
  @Get(':id/content')
  @Public()
  @SkipThrottle()
  async content(
    @Param('id') id: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    if (typeof sig !== 'string' || typeof exp !== 'string') throw new NotFoundException({ code: 'MEDIA_NOT_FOUND', message: 'Media not found' });
    const { media, object, maxAgeSeconds } = await this.media.openContent(id, Number(exp), sig, range);
    res.status(object.partial ? 206 : 200);
    res.setHeader('Content-Type', media.mimeType);
    if (object.contentLength !== undefined) res.setHeader('Content-Length', String(object.contentLength));
    if (object.contentRange) res.setHeader('Content-Range', object.contentRange);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', `private, max-age=${maxAgeSeconds}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(media.originalFilename)}`);
    object.body.on('error', () => res.destroy());
    object.body.pipe(res);
  }

  @Get(':id')
  @ApiBearerAuth()
  @RequireTenantPermission('media.read')
  get(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.media.get(tenant, id);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @RequireTenantPermission('media.write')
  update(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: UpdateMediaDto) {
    return this.media.update(tenant, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiBearerAuth()
  @RequireTenantPermission('media.write')
  remove(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.media.remove(tenant, id);
  }
}
