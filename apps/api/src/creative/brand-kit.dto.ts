import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { AI_TONES, BRAND_COLOR_ROLES, BRAND_FONT_NAMES, CREATIVE_LIMITS, HEX_COLOR, IMAGE_STYLES } from '@touma/shared';
import { ID_REGEX } from '../common/validators';

// eslint-disable-next-line no-control-regex -- control characters are stripped from free text on purpose
const clean = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() || null : value);

export class BrandColorDto {
  @ApiProperty({ example: 'Hibiscus red' }) @IsString() @MinLength(1) @MaxLength(30)
  name: string;

  @ApiProperty({ example: '#A81D3C' }) @Matches(HEX_COLOR, { message: 'hex must be a colour like #A81D3C' })
  hex: string;

  @ApiProperty({ enum: BRAND_COLOR_ROLES }) @IsIn(BRAND_COLOR_ROLES as unknown as string[])
  role: string;
}

/** Fields that are present are updated; send null to clear one. */
export class UpdateBrandKitDto {
  @ApiPropertyOptional({ type: [BrandColorDto] })
  @IsOptional() @IsArray() @ArrayMaxSize(CREATIVE_LIMITS.maxColors) @ValidateNested({ each: true }) @Type(() => BrandColorDto)
  colors?: BrandColorDto[];

  @ApiPropertyOptional({ enum: BRAND_FONT_NAMES, nullable: true }) @IsOptional() @IsIn(BRAND_FONT_NAMES as unknown as string[])
  headingFont?: string | null;

  @ApiPropertyOptional({ enum: BRAND_FONT_NAMES, nullable: true }) @IsOptional() @IsIn(BRAND_FONT_NAMES as unknown as string[])
  bodyFont?: string | null;

  @ApiPropertyOptional({ enum: IMAGE_STYLES, nullable: true }) @IsOptional() @IsIn(IMAGE_STYLES as unknown as string[])
  visualStyle?: string | null;

  @ApiPropertyOptional({ maxLength: CREATIVE_LIMITS.maxGuidelinesChars, nullable: true })
  @IsOptional() @Transform(clean) @IsString() @MaxLength(CREATIVE_LIMITS.maxGuidelinesChars)
  guidelines?: string | null;

  @ApiPropertyOptional({ enum: AI_TONES, nullable: true }) @IsOptional() @IsIn(AI_TONES as unknown as string[])
  preferredTone?: string | null;

  @ApiPropertyOptional({ description: 'An image of this business from the media library; becomes the business logo. null removes it.', nullable: true })
  @IsOptional() @IsString() @Matches(ID_REGEX)
  logoMediaId?: string | null;
}
