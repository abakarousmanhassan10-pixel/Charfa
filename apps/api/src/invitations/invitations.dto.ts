import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, MaxLength } from 'class-validator';
import { BUSINESS_ROLES } from '@touma/shared';

export class CreateInvitationDto {
  @ApiProperty({ example: 'teammate@example.com' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ enum: BUSINESS_ROLES })
  @IsIn(BUSINESS_ROLES as unknown as string[])
  role: 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';
}
