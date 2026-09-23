import { ApiProperty } from '@nestjs/swagger';
import { UploadPartUrlDto } from './upload-part-url.dto';

export class PartUrlsResponseDto {
  @ApiProperty({ type: [UploadPartUrlDto] })
  parts: UploadPartUrlDto[];

  @ApiProperty({ format: 'date-time' })
  partUrlsExpireAt: string;
}
