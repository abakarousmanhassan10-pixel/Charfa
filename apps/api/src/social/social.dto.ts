import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { PUBLICATION_STATUSES, SOCIAL_PLATFORMS } from '@touma/shared';
import { PageQueryDto } from '../common/pagination';
import { ID_REGEX } from '../common/validators';

const PLATFORMS = SOCIAL_PLATFORMS as unknown as string[];

export class StartConnectionDto {
  @ApiPropertyOptional({ description: 'Renew this account instead of adding a new one' }) @IsOptional() @IsString() @Matches(ID_REGEX)
  reconnectAccountId?: string;

  @ApiPropertyOptional({ description: 'LinkedIn: personal (default) or organization. Organization is disabled until LinkedIn approves the application' }) @IsOptional() @IsString() @Matches(/^[a-z]{3,20}$/)
  variant?: string;
}

export class SelectAccountsDto {
  @ApiProperty({ type: [String], description: 'externalAccountId of each account to connect' }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ArrayUnique() @IsString({ each: true }) @MaxLength(200, { each: true })
  externalAccountIds: string[];
}

export class PublicationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: SOCIAL_PLATFORMS }) @IsOptional() @IsIn(PLATFORMS)
  platform?: string;

  @ApiPropertyOptional({ enum: PUBLICATION_STATUSES }) @IsOptional() @IsIn(PUBLICATION_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(ID_REGEX)
  accountId?: string;
}

export class RetryPublicationDto {
  @ApiPropertyOptional({ description: 'Required when the outcome of the previous attempt is unknown: you confirm you checked the platform and the post does not exist' }) @IsOptional() @IsBoolean()
  confirmNotPublished?: boolean;
}

export class ManualCompleteDto {
  @ApiPropertyOptional({ description: 'Link to the post you published manually' }) @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value)) @IsString() @MaxLength(500) @Matches(/^https:\/\/\S+$/, { message: 'externalUrl must be an https link' })
  externalUrl?: string;

  @ApiProperty({ description: 'You confirm the post was published on the platform' }) @IsBoolean()
  confirmPublished: boolean;
}

export class AnalyticsQueryDto {
  @ApiPropertyOptional({ enum: SOCIAL_PLATFORMS }) @IsOptional() @IsIn(PLATFORMS)
  platform?: string;

  @ApiPropertyOptional({ default: 30 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365)
  days: number = 30;
}

export class SetEntryAccountDto {
  @ApiProperty() @IsString() @Matches(ID_REGEX)
  socialAccountId: string;
}
