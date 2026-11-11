import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AGENT_LANGUAGES, LEAD_STATUSES, SALES_LIMITS } from '@touma/shared';
import { ID_REGEX, Trim, TrimToNull } from '../common/validators';

const LANGS = AGENT_LANGUAGES as unknown as string[];
const LEADS = LEAD_STATUSES as unknown as string[];

export class UpdateAgentDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional() @IsOptional() @Trim() @IsString() @MinLength(1) @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({ enum: AGENT_LANGUAGES, isArray: true }) @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsIn(LANGS, { each: true })
  languages?: string[];

  @ApiPropertyOptional({ enum: AGENT_LANGUAGES }) @IsOptional() @IsIn(LANGS)
  defaultLanguage?: string;

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsString() @MaxLength(200)
  tone?: string | null;

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsString() @MaxLength(SALES_LIMITS.greetingMax)
  greeting?: string | null;

  @ApiPropertyOptional({ description: 'REVIEW: the AI drafts and a person approves every reply. AUTO: the AI answers customer-initiated chats itself (explicit authorization, audited)' }) @IsOptional() @IsIn(['REVIEW', 'AUTO'])
  replyMode?: 'REVIEW' | 'AUTO';

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(200)
  maxAiRepliesPerConversation?: number;
}

export class ConversationsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsIn(['OPEN', 'PENDING_HUMAN', 'RESOLVED', 'ARCHIVED'])
  status?: string;

  @ApiPropertyOptional() @IsOptional() @IsIn(['AI_ACTIVE', 'AI_PAUSED', 'HUMAN'])
  aiMode?: string;

  @ApiPropertyOptional() @IsOptional() @IsIn(LEADS)
  leadStatus?: string;

  @ApiPropertyOptional({ description: 'true: only conversations waiting for a person' }) @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean()
  needsHuman?: boolean;

  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean()
  includeTest?: boolean;

  @ApiPropertyOptional() @IsOptional() @Trim() @IsString() @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize: number = 20;
}

export class ReplyDto {
  @ApiProperty({ maxLength: SALES_LIMITS.messageMax }) @Trim() @IsString() @MinLength(1) @MaxLength(SALES_LIMITS.messageMax)
  body: string;
}

export class ApproveDraftDto {
  @ApiPropertyOptional({ description: 'Edited text to send instead of the AI draft' }) @IsOptional() @Trim() @IsString() @MinLength(1) @MaxLength(SALES_LIMITS.messageMax)
  body?: string;
}

export class FeedbackDto {
  @ApiProperty({ description: 'What was inaccurate' }) @Trim() @IsString() @MinLength(3) @MaxLength(1000)
  note: string;

  @ApiPropertyOptional({ description: 'The correct information' }) @IsOptional() @TrimToNull() @IsString() @MaxLength(2000)
  correction?: string | null;

  @ApiPropertyOptional({ description: 'Also add the correction to the business knowledge as an UNVERIFIED entry (it is used by the agent only after someone verifies it)' }) @IsOptional() @IsBoolean()
  addToKnowledge?: boolean;
}

export class PlaygroundDto {
  @ApiProperty() @Trim() @IsString() @MinLength(1) @MaxLength(SALES_LIMITS.messageMax)
  message: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(ID_REGEX)
  conversationId?: string;
}

export class CustomersQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsIn(LEADS)
  leadStatus?: string;

  @ApiPropertyOptional() @IsOptional() @Trim() @IsString() @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize: number = 20;
}

export class UpdateCustomerDto {
  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsString() @MaxLength(SALES_LIMITS.nameMax)
  name?: string | null;

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsEmail() @MaxLength(200)
  email?: string | null;

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsString() @Matches(/^[+\d][\d\s().-]{5,30}$/) @MaxLength(32)
  phone?: string | null;

  @ApiPropertyOptional({ enum: LEAD_STATUSES }) @IsOptional() @IsIn(LEADS)
  leadStatus?: string;

  @ApiPropertyOptional({ description: 'ISO date for the next follow-up; null clears it' }) @IsOptional() @TrimToNull() @IsString() @MaxLength(40)
  followUpAt?: string | null;

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsString() @Matches(ID_REGEX)
  assignedToId?: string | null;
}

export class NoteDto {
  @ApiProperty({ maxLength: SALES_LIMITS.notesMax }) @Trim() @IsString() @MinLength(1) @MaxLength(SALES_LIMITS.notesMax)
  body: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(ID_REGEX)
  conversationId?: string;
}

export class FaqDraftDto {
  @ApiProperty() @Trim() @IsString() @MinLength(3) @MaxLength(300)
  question: string;

  @ApiProperty() @Trim() @IsString() @MinLength(3) @MaxLength(4000)
  answer: string;
}

export class AnalyticsQueryDto {
  @ApiPropertyOptional({ default: 30 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365)
  days: number = 30;
}

// ─── Public chat ──────────────────────────────────────────────────────────────

export class PublicMessageDto {
  @ApiProperty({ maxLength: SALES_LIMITS.messageMax }) @Trim() @IsString() @MinLength(1) @MaxLength(SALES_LIMITS.messageMax)
  message: string;

  @ApiPropertyOptional({ description: 'Secret returned when the conversation started; required to continue it' }) @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_-]{40,60}$/)
  token?: string;

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsString() @MaxLength(SALES_LIMITS.nameMax)
  name?: string | null;

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsEmail() @MaxLength(200)
  email?: string | null;

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsString() @Matches(/^[+\d][\d\s().-]{5,30}$/) @MaxLength(32)
  phone?: string | null;

  @ApiPropertyOptional({ description: 'The customer agreed to be contacted at the details given' }) @IsOptional() @IsBoolean()
  consent?: boolean;
}

export class PublicPollDto {
  @ApiProperty() @IsString() @Matches(/^[A-Za-z0-9_-]{40,60}$/)
  token: string;
}
