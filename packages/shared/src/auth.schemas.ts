import { z } from 'zod';
import { SUPPORTED_LOCALES } from './i18n';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH)
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), {
    message: 'Password must contain lowercase, uppercase and a digit',
  });

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(1).max(120),
  locale: z.enum(SUPPORTED_LOCALES).default('en'),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof loginSchema>;

export interface AuthUserDto {
  id: string;
  email: string;
  fullName: string;
  locale: string;
  platformRole: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface AuthResponseDto {
  accessToken: string;
  accessTokenExpiresIn: number;
  user: AuthUserDto;
}
