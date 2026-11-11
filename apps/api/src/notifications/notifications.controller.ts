import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { ID_REGEX } from '../common/validators';
import { NotificationsService } from './notifications.service';

class ListNotificationsDto {
  @IsOptional() @IsString() @Matches(ID_REGEX) businessId?: string;
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() unread?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize = 20;
}

/** The signed-in user's own notifications (never another user's, whatever the business). */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() q: ListNotificationsDto) {
    return this.notifications.list(user.id, { businessId: q.businessId, unread: q.unread, page: q.page, pageSize: q.pageSize });
  }

  @Post('read-all')
  @HttpCode(200)
  readAll(@CurrentUser() user: AuthenticatedUser, @Query('businessId') businessId?: string) {
    return this.notifications.markAllRead(user.id, businessId);
  }

  @Post(':id/read')
  @HttpCode(200)
  read(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.markRead(user.id, id);
  }
}
