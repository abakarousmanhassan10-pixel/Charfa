import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, SUPPORTED_LOCALES } from '@touma/shared';

const normaliseEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @ApiProperty({ example: 'owner@example.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, description: 'Lowercase, uppercase and a digit required' })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Password must contain lowercase, uppercase and a digit',
  })
  password: string;

  @ApiProperty({ example: 'Amina Diallo' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  fullName: string;

  @ApiProperty({ enum: SUPPORTED_LOCALES, required: false, default: 'en' })
  @IsOptional()
  @IsIn(SUPPORTED_LOCALES as unknown as string[])
  locale?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'owner@example.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

export class AuthUserResponse {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() fullName: string;
  @ApiProperty() locale: string;
  @ApiProperty() timezone: string;
  @ApiProperty({ enum: ['USER', 'SUPPORT', 'SUPER_ADMIN'] }) platformRole: string;
  @ApiProperty() emailVerified: boolean;
  @ApiProperty() createdAt: string;
}

export class AuthResponse {
  @ApiProperty({ description: 'Short-lived JWT; send as Authorization: Bearer <token>' })
  accessToken: string;
  @ApiProperty({ description: 'Seconds until the access token expires' })
  accessTokenExpiresIn: number;
  @ApiProperty({ type: AuthUserResponse })
  user: AuthUserResponse;
}

export class EmailOnlyDto {
  @ApiProperty({ example: 'owner@example.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class TokenDto {
  @ApiProperty({ description: 'Token received by email' })
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token: string;
}

export class ResetPasswordDto extends TokenDto {
  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, { message: 'Password must contain lowercase, uppercase and a digit' })
  password: string;
}
