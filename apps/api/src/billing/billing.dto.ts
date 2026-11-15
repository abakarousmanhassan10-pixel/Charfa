import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Matches } from 'class-validator';

const RETURN_URL = /^(https:\/\/[^\s]{1,500}|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/[^\s]{0,500})?)$/;
const PLANS = ['STARTER', 'PRO', 'BUSINESS'] as const;
const MODES = ['AUTO', 'MANUAL'] as const;
const INTERVALS = ['MONTHLY', 'YEARLY'] as const;

export class StartTrialDto {
  @ApiProperty({ enum: PLANS }) @IsIn(PLANS as unknown as string[])
  plan!: (typeof PLANS)[number];

  @ApiPropertyOptional({ enum: MODES, description: 'AUTO = automatic renewal (needs autoRenewConsent), MANUAL = the customer renews each time (default)' }) @IsOptional() @IsIn(MODES as unknown as string[])
  billingMode?: (typeof MODES)[number];

  @ApiPropertyOptional({ enum: INTERVALS }) @IsOptional() @IsIn(INTERVALS as unknown as string[])
  billingInterval?: (typeof INTERVALS)[number];

  @ApiPropertyOptional({ description: 'Explicit consent to be charged automatically at each renewal' }) @IsOptional() @IsBoolean()
  autoRenewConsent?: boolean;
}

export class CreateSubscriptionDto extends StartTrialDto {
  @ApiPropertyOptional({ description: 'true (default): start the 72-hour free trial. false: create a pending subscription that becomes active only after a confirmed payment.' }) @IsOptional() @IsBoolean()
  trial?: boolean;
}

export class SetModeDto {
  @ApiProperty({ enum: MODES }) @IsIn(MODES as unknown as string[])
  billingMode!: (typeof MODES)[number];

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  autoRenewConsent?: boolean;
}

export class ChangePlanDto {
  @ApiProperty({ enum: PLANS }) @IsIn(PLANS as unknown as string[])
  plan!: (typeof PLANS)[number];

  @ApiPropertyOptional({ enum: INTERVALS }) @IsOptional() @IsIn(INTERVALS as unknown as string[])
  billingInterval?: (typeof INTERVALS)[number];
}

export class CardSetupDto {
  @ApiProperty({ description: 'Where the provider sends the customer back after the hosted page: https, or http only for localhost (local development)' })
  @IsString() @Matches(RETURN_URL, { message: 'returnUrl must be https (or http on localhost)' })
  returnUrl!: string;
}

export class SimulateDueDto {
  @ApiProperty({ enum: ['success', 'declined'] }) @IsIn(['success', 'declined'])
  outcome!: 'success' | 'declined';
}

export class SimulateConfirmDto extends SimulateDueDto {
  @ApiProperty() @IsString() @Matches(/^[a-z0-9]{20,40}$/)
  paymentId!: string;
}

export class RewindDto {
  @ApiProperty() @IsString() @Matches(/^\d{1,3}$/)
  days!: string;
}
