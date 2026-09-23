import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ALLOWED_VIDEO_MIME_TYPES,
  VIDEO_UPLOAD,
  type AllowedVideoMimeType,
} from '../videos.constants';

const ALLOWED_MIME_TYPE_VALUES = Object.keys(
  ALLOWED_VIDEO_MIME_TYPES,
) as AllowedVideoMimeType[];

export class InitiateUploadDto {
  @ApiProperty({ example: 'clip.mp4', maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName: string;

  @ApiProperty({ enum: ALLOWED_MIME_TYPE_VALUES, example: 'video/mp4' })
  @IsIn(ALLOWED_MIME_TYPE_VALUES)
  mimeType: AllowedVideoMimeType;

  @ApiProperty({
    example: 209715200,
    minimum: 1,
    maximum: VIDEO_UPLOAD.MAX_SIZE_BYTES,
    description: 'Declared file size in bytes; verified after completion.',
  })
  @IsInt()
  @Min(1)
  @Max(VIDEO_UPLOAD.MAX_SIZE_BYTES)
  sizeBytes: number;

  @ApiPropertyOptional({
    example: 'My clip',
    maxLength: 100,
    description: 'Defaults to the file name without its extension.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title?: string;
}
