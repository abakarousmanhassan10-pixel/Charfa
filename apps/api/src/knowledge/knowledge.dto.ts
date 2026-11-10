import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { KNOWLEDGE_CATEGORIES } from '@touma/shared';
import { PageQueryDto } from '../common/pagination';
import { Trim } from '../common/validators';

export class CreateKnowledgeDto {
  @ApiProperty({ enum: KNOWLEDGE_CATEGORIES }) @IsIn(KNOWLEDGE_CATEGORIES as unknown as string[])
  category: string;

  @ApiProperty({ example: 'Do you deliver on Sundays?', description: 'Title, or the question for FAQs' })
  @Trim() @IsString() @MinLength(2) @MaxLength(200)
  title: string;

  @ApiProperty({ example: 'Yes, in N’Djamena from 11:00 to 20:00. Delivery costs 1 000 XAF.' })
  @Trim() @IsString() @MinLength(2) @MaxLength(10_000)
  body: string;
}

export class UpdateKnowledgeDto extends PartialType(CreateKnowledgeDto) {}

export class KnowledgeQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: KNOWLEDGE_CATEGORIES }) @IsOptional() @IsIn(KNOWLEDGE_CATEGORIES as unknown as string[])
  category?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'] }) @IsOptional() @IsIn(['true', 'false'])
  verified?: 'true' | 'false';
}
