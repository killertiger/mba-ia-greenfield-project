import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsInt,
  Min,
} from 'class-validator';
import { VIDEO_UPLOAD } from '../videos.constants';

export class RequestPartUrlsDto {
  @ApiProperty({
    type: [Number],
    example: [2],
    description:
      'Part numbers to re-issue, each between 1 and the video part count.',
    minItems: 1,
    maxItems: VIDEO_UPLOAD.MAX_PARTS,
  })
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(VIDEO_UPLOAD.MAX_PARTS)
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
