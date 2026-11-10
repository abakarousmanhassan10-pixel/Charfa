import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PageQueryDto } from '../common/pagination';
import { CleanList, TrimToNull } from '../common/validators';

/** Folder paths: letters, digits, space, - _ and / separators; normalised, max 3 levels. */
export function normalizeFolder(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .split('/')
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('/');
}
const FOLDER_REGEX = /^$|^[\p{L}\p{N} _-]{1,40}(\/[\p{L}\p{N} _-]{1,40}){0,2}$/u;

export class MediaQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['IMAGE', 'VIDEO'] })
  @IsOptional()
  @IsIn(['IMAGE', 'VIDEO'])
  type?: 'IMAGE' | 'VIDEO';

  @ApiPropertyOptional({ description: 'Exact folder path; "" for root. Omit for all folders.' })
  @IsOptional()
  @Transform(({ value }) => normalizeFolder(value))
  @IsString()
  @Matches(FOLDER_REGEX, { message: 'folder contains invalid characters' })
  folder?: string;
}

export class UpdateMediaDto {
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @TrimToNull()
  @IsString()
  @MaxLength(300)
  altText?: string | null;

  @ApiPropertyOptional({ example: 'products/summer' })
  @IsOptional()
  @Transform(({ value }) => normalizeFolder(value))
  @IsString()
  @Matches(FOLDER_REGEX, { message: 'folder contains invalid characters' })
  folder?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @CleanList()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];
}

export { FOLDER_REGEX };
