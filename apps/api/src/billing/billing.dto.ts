import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsUrl } from 'class-validator';

export class StartTrialDto {
  @ApiProperty({ enum: ['STARTER', 'PRO', 'BUSINESS'] })
  @IsIn(['STARTER', 'PRO', 'BUSINESS'])
  plan!: 'STARTER' | 'PRO' | 'BUSINESS';
}

export class CardSetupDto {
  @ApiProperty({ description: 'Where the provider sends the customer back after the hosted card page (https)' })
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false })
  returnUrl!: string;
}
