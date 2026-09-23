import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'V1StGXR8Z5j' })
  slug: string;

  @ApiProperty({ example: 'My clip' })
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ example: 'video/mp4' })
  mimeType: string;

  @ApiProperty({ example: 209715200 })
  sizeBytes: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 12.5 })
  durationSeconds: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 1920 })
  width: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 1080 })
  height: number | null;

  @ApiPropertyOptional({
    type: Object,
    nullable: true,
    description: 'Codecs, bitrate, container format and frame rate.',
  })
  metadata: Record<string, unknown> | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Presigned GET URL; null until the thumbnail exists.',
  })
  thumbnailUrl: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  processingError: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}
