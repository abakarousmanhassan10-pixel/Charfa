import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import {
  AI_LANGUAGES, AI_TONES, ASPECT_RATIOS, CREATIVE_LIMITS, CREATIVE_PLATFORMS, IMAGE_BACKGROUNDS, IMAGE_STYLES, IMAGE_THEMES, IMAGE_TYPES, LOGO_PLACEMENTS,
  OVERLAY_POSITIONS, PRESERVATION_MODES, RESOLUTION_KEYS, VIDEO_FORMAT_KEYS, VIDEO_STYLES,
} from '@touma/shared';
import { PageQueryDto } from '../common/pagination';
import { ID_REGEX } from '../common/validators';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

export class CreateImageDto {
  @ApiProperty({ enum: IMAGE_TYPES }) @IsIn(IMAGE_TYPES as unknown as string[])
  type: string;

  @ApiPropertyOptional({ enum: IMAGE_STYLES, description: 'Default: the brand kit style, else photorealistic' }) @IsOptional() @IsIn(IMAGE_STYLES as unknown as string[])
  style?: string;

  @ApiProperty({ enum: ASPECT_RATIOS }) @IsIn(ASPECT_RATIOS as unknown as string[])
  aspectRatio: string;

  @ApiPropertyOptional({ enum: RESOLUTION_KEYS, default: 'STANDARD' }) @IsOptional() @IsIn(RESOLUTION_KEYS as unknown as string[])
  resolution: string = 'STANDARD';

  @ApiPropertyOptional({ enum: IMAGE_BACKGROUNDS, default: 'WHITE_STUDIO' }) @IsOptional() @IsIn(IMAGE_BACKGROUNDS as unknown as string[])
  background: string = 'WHITE_STUDIO';

  @ApiPropertyOptional({ maxLength: 200 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(200)
  backgroundNote?: string;

  @ApiPropertyOptional({ enum: IMAGE_THEMES, default: 'NONE' }) @IsOptional() @IsIn(IMAGE_THEMES as unknown as string[])
  theme: string = 'NONE';

  @ApiPropertyOptional({ maxLength: 120 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(120)
  themeNote?: string;

  @ApiPropertyOptional({ maxLength: CREATIVE_LIMITS.maxOverlayChars, description: 'Text drawn on the image by TOUMA. It is checked against your verified business data.' })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(CREATIVE_LIMITS.maxOverlayChars)
  overlayText?: string;

  @ApiPropertyOptional({ enum: OVERLAY_POSITIONS, default: 'BOTTOM' }) @IsOptional() @IsIn(OVERLAY_POSITIONS as unknown as string[])
  overlayPosition: string = 'BOTTOM';

  @ApiPropertyOptional({ enum: LOGO_PLACEMENTS, default: 'NONE' }) @IsOptional() @IsIn(LOGO_PLACEMENTS as unknown as string[])
  logoPlacement: string = 'NONE';

  @ApiPropertyOptional({ enum: CREATIVE_PLATFORMS, default: 'ANY' }) @IsOptional() @IsIn(CREATIVE_PLATFORMS as unknown as string[])
  platform: string = 'ANY';

  @ApiPropertyOptional({ enum: ['PRODUCT', 'SERVICE'] }) @IsOptional() @IsIn(['PRODUCT', 'SERVICE'])
  itemType?: 'PRODUCT' | 'SERVICE';

  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(ID_REGEX)
  itemId?: string;

  @ApiPropertyOptional({ description: "The merchant's original product photo (an image of this business in the media library)" }) @IsOptional() @IsString() @Matches(ID_REGEX)
  sourceMediaId?: string;

  @ApiPropertyOptional({ enum: PRESERVATION_MODES, default: 'EXACT', description: 'EXACT composites the real product pixels on a generated scene; GUIDED asks the model to edit the photo and keep the product unchanged (best effort)' })
  @IsOptional() @IsIn(PRESERVATION_MODES as unknown as string[])
  preservation: string = 'EXACT';

  @ApiPropertyOptional({ minimum: 1, maximum: CREATIVE_LIMITS.maxImagesPerRequest, default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(CREATIVE_LIMITS.maxImagesPerRequest)
  count: number = 1;

  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean()
  useBrandKit: boolean = true;

  @ApiPropertyOptional({ maxLength: CREATIVE_LIMITS.maxInstructionChars }) @IsOptional() @Transform(trim) @IsString() @MaxLength(CREATIVE_LIMITS.maxInstructionChars)
  instructions?: string;
}

export class CreateVideoDto {
  @ApiProperty({ enum: VIDEO_FORMAT_KEYS }) @IsIn(VIDEO_FORMAT_KEYS as unknown as string[])
  format: string;

  @ApiProperty({ minimum: 4, maximum: 90, description: 'Wanted length. The provider renders the shortest clip it supports that covers it; that length is what is reserved and billed.' })
  @Type(() => Number) @IsInt() @Min(4) @Max(90)
  seconds: number;

  @ApiPropertyOptional({ enum: VIDEO_STYLES, default: 'CINEMATIC' }) @IsOptional() @IsIn(VIDEO_STYLES as unknown as string[])
  style: string = 'CINEMATIC';

  @ApiPropertyOptional({ enum: ['PRODUCT', 'SERVICE'] }) @IsOptional() @IsIn(['PRODUCT', 'SERVICE'])
  itemType?: 'PRODUCT' | 'SERVICE';

  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(ID_REGEX)
  itemId?: string;

  @ApiPropertyOptional({ description: 'A successful storyboard of this business to turn into video' }) @IsOptional() @IsString() @Matches(ID_REGEX)
  storyboardId?: string;

  @ApiPropertyOptional({ description: 'Render only this scene of the storyboard' }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30)
  sceneOrder?: number;

  @ApiPropertyOptional({ description: 'A product photo to animate (when the provider supports it)' }) @IsOptional() @IsString() @Matches(ID_REGEX)
  sourceMediaId?: string;

  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean()
  useBrandKit: boolean = true;

  @ApiPropertyOptional({ maxLength: CREATIVE_LIMITS.maxInstructionChars }) @IsOptional() @Transform(trim) @IsString() @MaxLength(CREATIVE_LIMITS.maxInstructionChars)
  instructions?: string;
}

export class CreateStoryboardDto {
  @ApiProperty({ enum: AI_LANGUAGES }) @IsIn(AI_LANGUAGES as unknown as string[])
  language: string;

  @ApiProperty({ enum: VIDEO_FORMAT_KEYS }) @IsIn(VIDEO_FORMAT_KEYS as unknown as string[])
  format: string;

  @ApiProperty({ minimum: 4, maximum: 90 }) @Type(() => Number) @IsInt() @Min(4) @Max(90)
  seconds: number;

  @ApiPropertyOptional({ enum: VIDEO_STYLES, default: 'CINEMATIC' }) @IsOptional() @IsIn(VIDEO_STYLES as unknown as string[])
  style: string = 'CINEMATIC';

  @ApiPropertyOptional({ enum: AI_TONES, default: 'FRIENDLY' }) @IsOptional() @IsIn(AI_TONES as unknown as string[])
  tone: string = 'FRIENDLY';

  @ApiPropertyOptional({ enum: ['PRODUCT', 'SERVICE'] }) @IsOptional() @IsIn(['PRODUCT', 'SERVICE'])
  itemType?: 'PRODUCT' | 'SERVICE';

  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(ID_REGEX)
  itemId?: string;

  @ApiPropertyOptional({ maxLength: CREATIVE_LIMITS.maxInstructionChars }) @IsOptional() @Transform(trim) @IsString() @MaxLength(CREATIVE_LIMITS.maxInstructionChars)
  instructions?: string;
}

export class VariationDto {
  @ApiPropertyOptional({ minimum: 1, maximum: CREATIVE_LIMITS.maxImagesPerRequest, default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(CREATIVE_LIMITS.maxImagesPerRequest)
  count: number = 1;

  @ApiPropertyOptional({ maxLength: CREATIVE_LIMITS.maxInstructionChars }) @IsOptional() @Transform(trim) @IsString() @MaxLength(CREATIVE_LIMITS.maxInstructionChars)
  instructions?: string;
}

export class CreativeQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['IMAGE', 'VIDEO'] }) @IsOptional() @IsIn(['IMAGE', 'VIDEO'])
  kind?: 'IMAGE' | 'VIDEO';

  @ApiPropertyOptional({ enum: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'] }) @IsOptional() @IsIn(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'])
  status?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(ID_REGEX)
  itemId?: string;
}

export class SelectOutputDto {
  @ApiProperty() @IsBoolean()
  selected: boolean;
}
