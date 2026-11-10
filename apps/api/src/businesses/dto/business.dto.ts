import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, Validate } from 'class-validator';
import { BUSINESS_ROLES, BUSINESS_TYPES, SUPPORTED_LOCALES } from '@touma/shared';
import { IsIanaTimezone } from '../../users/users.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Empty optional text becomes null, which clears the stored value on update. */
const trimEmptyToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const v = value.trim();
  return v === '' ? null : v;
};
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const upperEmptyToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const v = value.trim().toUpperCase();
  return v === '' ? null : v;
};

export class CreateBusinessDto {
  @ApiProperty({ example: 'Café Awa' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({ enum: BUSINESS_TYPES })
  @IsIn(BUSINESS_TYPES as unknown as string[])
  type: string;

  @ApiPropertyOptional() @IsOptional() @Transform(trimEmptyToNull) @IsString() @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ example: 'https://cafe-awa.example' })
  @IsOptional()
  @Transform(trimEmptyToNull)
  @IsString()
  @MaxLength(2048)
  @Matches(/^https?:\/\/[^\s]+$/i, { message: 'website must start with http:// or https://' })
  website?: string | null;

  @ApiPropertyOptional() @IsOptional() @Transform(trimEmptyToNull) @IsString() @MaxLength(120)
  industry?: string | null;

  @ApiPropertyOptional({ example: 'TD', description: 'ISO 3166-1 alpha-2' })
  @IsOptional()
  @Transform(upperEmptyToNull)
  @Matches(/^[A-Z]{2}$/, { message: 'country must be a 2-letter ISO code' })
  country?: string | null;

  @ApiPropertyOptional({ enum: SUPPORTED_LOCALES, default: 'en' })
  @IsOptional()
  @IsIn(SUPPORTED_LOCALES as unknown as string[])
  defaultLocale?: string;

  @ApiPropertyOptional({ example: 'Africa/Ndjamena', default: 'UTC' })
  @IsOptional()
  @Validate(IsIanaTimezone)
  timezone?: string;

  @ApiPropertyOptional({ example: 'XAF', default: 'USD', description: 'ISO 4217' })
  @IsOptional()
  @Transform(upper)
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO 4217 code' })
  currency?: string;

  @ApiPropertyOptional() @IsOptional() @Transform(trimEmptyToNull) @IsString() @MaxLength(2000)
  brandVoice?: string | null;

  @ApiPropertyOptional() @IsOptional() @Transform(trimEmptyToNull) @IsString() @MaxLength(2000)
  targetAudience?: string | null;

  @ApiPropertyOptional() @IsOptional() @Transform(trimEmptyToNull) @IsString() @MaxLength(2000)
  objectives?: string | null;
}

export class UpdateBusinessDto extends PartialType(CreateBusinessDto) {}

export class DeleteBusinessDto {
  @ApiProperty({ description: 'Must equal the business name exactly, to confirm deletion' })
  @IsString()
  @MaxLength(120)
  confirmName: string;
}

export class UpdateMemberRoleDto {
  @ApiProperty({ enum: BUSINESS_ROLES })
  @IsIn(BUSINESS_ROLES as unknown as string[])
  role: string;
}
