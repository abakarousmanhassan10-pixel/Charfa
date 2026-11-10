import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength, Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { SUPPORTED_LOCALES } from '@touma/shared';

@ValidatorConstraint({ name: 'ianaTimezone' })
export class IsIanaTimezone implements ValidatorConstraintInterface {
  validate(value: unknown) {
    if (typeof value !== 'string') return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }
  defaultMessage() {
    return 'timezone must be a valid IANA timezone (e.g. Europe/Paris)';
  }
}

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  fullName?: string;

  @ApiPropertyOptional({ enum: SUPPORTED_LOCALES })
  @IsOptional()
  @IsIn(SUPPORTED_LOCALES as unknown as string[])
  locale?: string;

  @ApiPropertyOptional({ example: 'Africa/Ndjamena' })
  @IsOptional()
  @Validate(IsIanaTimezone)
  timezone?: string;
}
