import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';
import { UploadPartUrlDto } from './upload-part-url.dto';

export class InitiateUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'V1StGXR8Z5j' })
  slug: string;

  @ApiProperty({ example: 'clip' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ example: 104857600 })
  partSizeBytes: number;

  @ApiProperty({ example: 2 })
  partCount: number;

  @ApiProperty({ type: [UploadPartUrlDto] })
  parts: UploadPartUrlDto[];

  @ApiProperty({ format: 'date-time' })
  partUrlsExpireAt: string;
}
