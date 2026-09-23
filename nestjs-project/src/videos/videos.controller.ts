import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { DeliveryUrlResponseDto } from './dto/delivery-url-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import { RequestPartUrlsDto } from './dto/request-part-urls.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VIDEO_DELIVERY_MODES } from './videos.constants';
import { VideosService } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@SkipThrottle()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft in the caller channel, opens a multipart upload in object storage and returns one presigned URL per part. File bytes are sent by the client directly to storage.',
  })
  @ApiCreatedResponse({
    description: 'Draft created and upload started',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':slug/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-issue presigned URLs for parts of an open upload',
    description:
      'Resume path for an interrupted upload: returns a fresh presigned URL for each requested part, so only the missing parts are transferred again.',
  })
  @ApiParam({ name: 'slug', example: 'V1StGXR8Z5j' })
  @ApiOkResponse({
    description: 'URLs re-issued',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or a part number is out of range',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with this slug in the caller channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The upload is no longer open',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async reissuePartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Body() dto: RequestPartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    return this.videosService.reissuePartUrls(user.sub, slug, dto);
  }

  @Post(':slug/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Finish the upload and queue the video for processing',
    description:
      'Completes the multipart upload with the ETags of every part, verifies the stored size and moves the video to `processing`, where the worker picks it up.',
  })
  @ApiParam({ name: 'slug', example: 'V1StGXR8Z5j' })
  @ApiAcceptedResponse({
    description: 'Upload completed and queued for processing',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 400,
    description: 'The parts do not cover the upload exactly',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with this slug in the caller channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The upload is no longer open',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Storage rejected the parts, or the stored size is invalid',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, slug, dto);
  }

  @Get(':slug')
  @ApiOperation({
    summary: 'Get a video and its processing state',
    description:
      'Returns the video lifecycle status, the metadata extracted during processing, a presigned thumbnail URL once it exists and the failure reason when processing failed.',
  })
  @ApiParam({ name: 'slug', example: 'V1StGXR8Z5j' })
  @ApiOkResponse({ description: 'The video', type: VideoResponseDto })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with this slug in the caller channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getOwnedVideo(user.sub, slug);
  }

  @Get(':slug/stream')
  @ApiOperation({
    summary: 'Get a playback URL for the video',
    description:
      'Returns a presigned URL the player requests directly from storage. Range requests are answered by storage with 206 Partial Content — the bytes never pass through the API.',
  })
  @ApiParam({ name: 'slug', example: 'V1StGXR8Z5j' })
  @ApiOkResponse({ description: 'Playback URL', type: DeliveryUrlResponseDto })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with this slug in the caller channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video is not ready yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async streamVideo(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<DeliveryUrlResponseDto> {
    return this.videosService.getDeliveryUrl(
      user.sub,
      slug,
      VIDEO_DELIVERY_MODES.STREAM,
    );
  }

  @Get(':slug/download')
  @ApiOperation({
    summary: 'Get a download URL for the video',
    description:
      'Returns a presigned URL that serves the original file as an attachment, named after the uploaded file.',
  })
  @ApiParam({ name: 'slug', example: 'V1StGXR8Z5j' })
  @ApiOkResponse({ description: 'Download URL', type: DeliveryUrlResponseDto })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with this slug in the caller channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video is not ready yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async downloadVideo(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<DeliveryUrlResponseDto> {
    return this.videosService.getDeliveryUrl(
      user.sub,
      slug,
      VIDEO_DELIVERY_MODES.DOWNLOAD,
    );
  }
}
