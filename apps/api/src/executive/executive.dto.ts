import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Max, Min, ValidateNested } from 'class-validator';

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const PERCENT = /^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/;
const CURRENCY = /^[A-Z]{3}$/;
const money = { message: 'a non-negative amount with at most 2 decimals' };

export class EconomicsDto {
  @ApiProperty({ example: 'XAF' }) @Matches(CURRENCY)
  currency: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Matches(MONEY, money)
  unitCost?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Matches(MONEY, money)
  shippingCost?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Matches(PERCENT, { message: 'a percentage from 0 to 100' })
  paymentFeePercent?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Matches(MONEY, money)
  paymentFixedFee?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Matches(PERCENT, { message: 'a percentage from 0 to 100' })
  returnsAllowancePercent?: string | null;
}

export class ExpenseDto {
  @ApiProperty() @Matches(MONEY, money)
  amount: string;
  @ApiProperty() @Matches(CURRENCY)
  currency: string;
  @ApiProperty({ example: '2026-11-01' }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
  spentOn: string;
  @ApiPropertyOptional({ description: 'Orders you attribute to this spend, if you know.' }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000)
  orders?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 200)
  note?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_-]{10,40}$/)
  campaignId?: string;
}

export class ScenarioDto {
  @ApiProperty() @IsString() @Length(1, 60)
  name: string;
  @ApiPropertyOptional() @IsOptional() @Matches(MONEY, money)
  price?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(MONEY, money)
  shippingCost?: string;
  @ApiPropertyOptional({ description: 'A simulation: nothing is spent.' }) @IsOptional() @Matches(MONEY, money)
  adBudget?: string;
  @ApiPropertyOptional({ description: 'Assumed cost per click.' }) @IsOptional() @Matches(MONEY, money)
  costPerClick?: string;
  @ApiPropertyOptional({ description: 'Assumed share of clicks that become orders, 0-100.' }) @IsOptional() @Matches(PERCENT)
  conversionPercent?: string;
}

export class ScenariosDto {
  @ApiProperty() @IsString() @Matches(/^[A-Za-z0-9_-]{10,40}$/)
  productId: string;
  @ApiProperty({ type: [ScenarioDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => ScenarioDto)
  scenarios: ScenarioDto[];
}

export class SettingsDto {
  @ApiPropertyOptional({ description: 'Emergency stop.' }) @IsOptional() @IsBoolean()
  paused?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  dailyRunLimit?: number;
}
