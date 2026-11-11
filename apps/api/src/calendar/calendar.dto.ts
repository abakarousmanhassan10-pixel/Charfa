import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { AI_LANGUAGES, AI_PLATFORMS, AI_TONES, SOCIAL_PLATFORMS, CALENDAR_LIMITS, CONTENT_PILLARS, DATE_RE, ENTRY_STATUSES, RECURRENCE_FREQUENCIES, TIME_RE } from '@touma/shared';
import { ID_REGEX } from '../common/validators';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);
const PLATFORMS = SOCIAL_PLATFORMS as unknown as string[];
const AI_PLATFORM_LIST = AI_PLATFORMS as unknown as string[];
const CONTENT_TYPES = ['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL'];

class TimeFields {
  @ApiPropertyOptional({ description: 'UTC instant (ISO 8601). Use this OR localDate (+ localTime).' }) @IsOptional() @IsString() @MaxLength(40)
  scheduledAt?: string;

  @ApiPropertyOptional({ description: 'Date in the business timezone, YYYY-MM-DD', example: '2026-12-01' }) @IsOptional() @Matches(DATE_RE)
  localDate?: string;

  @ApiPropertyOptional({ description: 'Wall-clock time in the business timezone, HH:mm. Omit it to use the recommended time.', example: '09:00' }) @IsOptional() @Matches(TIME_RE)
  localTime?: string;
}

export class CreateEntryDto extends TimeFields {
  @ApiProperty({ maxLength: CALENDAR_LIMITS.titleMax }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(CALENDAR_LIMITS.titleMax)
  title: string;

  @ApiProperty({ enum: SOCIAL_PLATFORMS }) @IsIn(PLATFORMS)
  platform: string;

  @ApiPropertyOptional({ enum: CONTENT_PILLARS }) @IsOptional() @IsIn(CONTENT_PILLARS as unknown as string[])
  pillar?: string;

  @ApiPropertyOptional({ enum: CONTENT_TYPES, default: 'TEXT' }) @IsOptional() @IsIn(CONTENT_TYPES)
  contentType: string = 'TEXT';

  @ApiPropertyOptional({ maxLength: CALENDAR_LIMITS.briefMax }) @IsOptional() @Transform(trim) @IsString() @MaxLength(CALENDAR_LIMITS.briefMax)
  brief?: string;

  @ApiPropertyOptional({ maxLength: CALENDAR_LIMITS.captionMax }) @IsOptional() @Transform(trim) @IsString() @MaxLength(CALENDAR_LIMITS.captionMax)
  caption?: string;

  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(60, { each: true })
  hashtags?: string[];

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(250)
  callToAction?: string;

  @ApiPropertyOptional({ enum: AI_LANGUAGES }) @IsOptional() @IsIn(AI_LANGUAGES as unknown as string[])
  language?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(ID_REGEX)
  productId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(ID_REGEX)
  serviceId?: string;

  @ApiPropertyOptional({ type: [String], description: 'Media library items (ready, same business)' }) @IsOptional() @IsArray() @ArrayMaxSize(10) @ArrayUnique() @IsString({ each: true }) @Matches(ID_REGEX, { each: true })
  mediaIds?: string[];

  @ApiPropertyOptional({ description: 'Accept soft conflicts (too close, daily limit, no connected account)' }) @IsOptional() @IsBoolean()
  acknowledgeConflicts: boolean = false;
}

export class UpdateEntryDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(CALENDAR_LIMITS.titleMax)
  title?: string;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsString() @MaxLength(CALENDAR_LIMITS.captionMax)
  caption?: string | null;

  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(60, { each: true })
  hashtags?: string[];

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsString() @MaxLength(250)
  callToAction?: string | null;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsString() @MaxLength(CALENDAR_LIMITS.briefMax)
  brief?: string | null;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsString() @MaxLength(1000)
  notes?: string | null;

  @ApiPropertyOptional({ enum: CONTENT_PILLARS }) @IsOptional() @IsIn(CONTENT_PILLARS as unknown as string[])
  pillar?: string;

  @ApiPropertyOptional({ enum: CONTENT_TYPES }) @IsOptional() @IsIn(CONTENT_TYPES)
  contentType?: string;

  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @ArrayUnique() @IsString({ each: true }) @Matches(ID_REGEX, { each: true })
  mediaIds?: string[];
}

export class RescheduleDto extends TimeFields {
  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  acknowledgeConflicts: boolean = false;
}

export class AuthorizeDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  acknowledgeConflicts: boolean = false;
}

export class DecisionDto {
  @ApiPropertyOptional({ maxLength: 500 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(500)
  note?: string;
}

export class RejectDto {
  @ApiProperty({ maxLength: 500 }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(500)
  reason: string;
}

export class UseContentDto {
  @ApiProperty() @IsString() @Matches(ID_REGEX)
  contentId: string;
}

export class RangeQueryDto {
  @ApiProperty({ example: '2026-12-01', description: 'First local date (business timezone)' }) @Matches(DATE_RE)
  from: string;

  @ApiProperty({ example: '2026-12-31', description: `Last local date, at most ${CALENDAR_LIMITS.rangeMaxDays} days after from` }) @Matches(DATE_RE)
  to: string;

  @ApiPropertyOptional({ enum: AI_PLATFORMS }) @IsOptional() @IsIn(PLATFORMS)
  platform?: string;

  @ApiPropertyOptional({ enum: ENTRY_STATUSES }) @IsOptional() @IsIn(ENTRY_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ enum: CONTENT_PILLARS }) @IsOptional() @IsIn(CONTENT_PILLARS as unknown as string[])
  pillar?: string;
}

export class RecommendQueryDto {
  @ApiProperty({ enum: SOCIAL_PLATFORMS }) @IsIn(PLATFORMS)
  platform: string;

  @ApiProperty({ example: '2026-12-01' }) @Matches(DATE_RE)
  date: string;
}

export class ApprovalsQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'decided'], default: 'pending' }) @IsOptional() @IsIn(['pending', 'decided'])
  view: 'pending' | 'decided' = 'pending';

  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  pageSize: number = 20;
}

export class OccasionDto {
  @ApiProperty({ example: '2026-12-24' }) @Matches(DATE_RE)
  date: string;

  @ApiProperty({ maxLength: 80, example: 'Opening anniversary' }) @Transform(trim) @IsString() @MinLength(2) @MaxLength(80)
  name: string;
}

export class CreatePlanDto {
  @ApiProperty({ example: '2026-12-01', description: 'First day of the plan (business timezone); not in the past' }) @Matches(DATE_RE)
  startDate: string;

  @ApiPropertyOptional({ default: 30, minimum: CALENDAR_LIMITS.planMinDays, maximum: CALENDAR_LIMITS.planMaxDays }) @IsOptional() @Type(() => Number) @IsInt() @Min(CALENDAR_LIMITS.planMinDays) @Max(CALENDAR_LIMITS.planMaxDays)
  days: number = 30;

  @ApiPropertyOptional({ default: 5 }) @IsOptional() @Type(() => Number) @IsInt() @Min(CALENDAR_LIMITS.postsPerWeekMin) @Max(CALENDAR_LIMITS.postsPerWeekMax)
  postsPerWeek: number = 5;

  @ApiProperty({ enum: AI_PLATFORMS, isArray: true }) @IsArray() @ArrayMinSize(1) @ArrayUnique() @ArrayMaxSize(4) @IsIn(AI_PLATFORM_LIST, { each: true })
  platforms: string[];

  @ApiPropertyOptional({ enum: AI_LANGUAGES, description: 'Default: the business language' }) @IsOptional() @IsIn(AI_LANGUAGES as unknown as string[])
  language?: string;

  @ApiPropertyOptional({ enum: AI_TONES }) @IsOptional() @IsIn(AI_TONES as unknown as string[])
  tone?: string;

  @ApiPropertyOptional({ maxLength: 300, description: 'Marketing objective for this plan (the business objectives are used too)' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(300)
  goal?: string;

  @ApiPropertyOptional({ type: [OccasionDto], description: 'Holidays, events or campaigns YOU want the plan to use. TOUMA never invents occasions: without them there are no seasonal posts.' })
  @IsOptional() @IsArray() @ArrayMaxSize(CALENDAR_LIMITS.occasionsMax) @ValidateNested({ each: true }) @Type(() => OccasionDto)
  occasions: OccasionDto[] = [];

  @ApiPropertyOptional({ maxLength: 500 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(500)
  instructions?: string;
}

export class ApplyPlanDto {
  @ApiPropertyOptional({ description: 'Entry numbers (index in the plan) to leave out', type: [Number] }) @IsOptional() @IsArray() @ArrayMaxSize(CALENDAR_LIMITS.planMaxItems) @IsInt({ each: true }) @Min(0, { each: true })
  skip: number[] = [];
}

export class CreateRecurrenceDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(CALENDAR_LIMITS.titleMax)
  title: string;

  @ApiProperty({ enum: SOCIAL_PLATFORMS }) @IsIn(PLATFORMS)
  platform: string;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(CALENDAR_LIMITS.briefMax)
  brief?: string;

  @ApiPropertyOptional({ enum: CONTENT_PILLARS }) @IsOptional() @IsIn(CONTENT_PILLARS as unknown as string[])
  pillar?: string;

  @ApiProperty({ enum: RECURRENCE_FREQUENCIES }) @IsIn(RECURRENCE_FREQUENCIES as unknown as string[])
  frequency: string;

  @ApiPropertyOptional({ description: '0 = Sunday … 6 = Saturday; required for WEEKLY', type: [Number] }) @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true })
  weekdays?: number[];

  @ApiProperty({ example: '09:00', description: 'Local time in the business timezone' }) @Matches(TIME_RE)
  localTime: string;

  @ApiProperty() @Matches(DATE_RE)
  startDate: string;

  @ApiProperty({ description: `At most ${CALENDAR_LIMITS.recurrenceMaxDays} days after startDate` }) @Matches(DATE_RE)
  endDate: string;
}
