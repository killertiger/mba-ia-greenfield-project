import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class CompleteUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'V1StGXR8Z5j' })
  slug: string;

  @ApiProperty({ enum: [VideoStatus.PROCESSING], example: 'processing' })
  status: VideoStatus;
}
