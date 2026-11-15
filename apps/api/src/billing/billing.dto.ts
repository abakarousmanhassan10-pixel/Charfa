import { ApiProperty } from '@nestjs/swagger';
import { IsIn, Matches } from 'class-validator';

export class StartTrialDto {
  @ApiProperty({ enum: ['STARTER', 'PRO', 'BUSINESS'] })
  @IsIn(['STARTER', 'PRO', 'BUSINESS'])
  plan!: 'STARTER' | 'PRO' | 'BUSINESS';
}

export class CardSetupDto {
  @ApiProperty({ description: 'Where the provider sends the customer back after the hosted card page: https, or http only for localhost (local development)' })
  @Matches(/^(https:\/\/[^\s]{1,500}|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/[^\s]{0,500})?)$/, { message: 'returnUrl must be https (or http on localhost)' })
  returnUrl!: string;
}
