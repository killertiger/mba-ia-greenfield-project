import { ApiProperty } from '@nestjs/swagger';

export class DeliveryUrlResponseDto {
  @ApiProperty({
    description: 'Presigned GET URL the client requests directly from storage.',
  })
  url: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;
}
