import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { MultipartCompletionError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { DeliveryUrlResponseDto } from './dto/delivery-url-response.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import { RequestPartUrlsDto } from './dto/request-part-urls.dto';
import { UploadPartUrlDto } from './dto/upload-part-url.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generateVideoSlug } from './slug.util';
import {
  ALLOWED_VIDEO_MIME_TYPES,
  VIDEO_DELIVERY_MODES,
  VIDEO_SLUG,
  VIDEO_UPLOAD,
  type VideoDeliveryMode,
} from './videos.constants';
import { VideoProcessingQueue } from './video-processing.queue';
import {
  InvalidPartNumbersException,
  UploadPartsInvalidException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotInDraftException,
  VideoNotReadyException,
} from './videos.exceptions';

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_COLUMN = 'slug';

function isSlugUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error as unknown as { code?: string; detail?: string };
  return (
    driverError.code === PG_UNIQUE_VIOLATION &&
    typeof driverError.detail === 'string' &&
    driverError.detail.includes(SLUG_COLUMN)
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videoProcessingQueue: VideoProcessingQueue,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`Authenticated user ${userId} has no channel`);
    }

    const id = randomUUID();
    const extension = ALLOWED_VIDEO_MIME_TYPES[dto.mimeType];
    const storageKey = `videos/${id}/original.${extension}`;
    const partCount = Math.ceil(dto.sizeBytes / VIDEO_UPLOAD.PART_SIZE_BYTES);

    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.mimeType,
    );

    let video: Video;
    try {
      video = await this.persistDraft({
        id,
        channelId: channel.id,
        dto,
        storageKey,
        uploadId,
        partCount,
      });
    } catch (error) {
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
      throw error;
    }

    const parts = await this.presignParts(
      storageKey,
      uploadId,
      Array.from({ length: partCount }, (_, index) => index + 1),
    );

    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      partSizeBytes: video.part_size_bytes,
      partCount: video.part_count,
      parts,
      partUrlsExpireAt: this.expiresAt(
        this.storageService.uploadPartUrlTtlSeconds,
      ),
    };
  }

  /**
   * Ownership guard shared by every `/videos/:slug*` endpoint: a slug that is
   * malformed, unknown or owned by another channel is indistinguishable from
   * the caller's point of view (per TD-08).
   */
  async findOwnedBySlug(userId: string, slug: string): Promise<Video> {
    if (!VIDEO_SLUG.PATTERN.test(slug)) {
      throw new VideoNotFoundException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoNotFoundException();
    }

    const video = await this.videoRepository.findOne({
      where: { slug, channel_id: channel.id },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  async reissuePartUrls(
    userId: string,
    slug: string,
    dto: RequestPartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    const video = await this.findOwnedBySlug(userId, slug);

    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotInDraftException();
    }

    const outOfRange = dto.partNumbers.filter(
      (partNumber) => partNumber > video.part_count,
    );
    if (outOfRange.length > 0) {
      throw new InvalidPartNumbersException(
        `partNumbers must be between 1 and ${video.part_count}; received ${outOfRange.join(', ')}`,
      );
    }

    return {
      parts: await this.presignParts(
        video.storage_key,
        video.upload_id,
        dto.partNumbers,
      ),
      partUrlsExpireAt: this.expiresAt(
        this.storageService.uploadPartUrlTtlSeconds,
      ),
    };
  }

  async getOwnedVideo(userId: string, slug: string): Promise<VideoResponseDto> {
    const video = await this.findOwnedBySlug(userId, slug);

    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      mimeType: video.mime_type,
      // bigint and numeric come back as strings from TypeORM.
      sizeBytes: Number(video.size_bytes),
      durationSeconds:
        video.duration_seconds === null ? null : Number(video.duration_seconds),
      width: video.width,
      height: video.height,
      metadata: video.metadata,
      thumbnailUrl: video.thumbnail_key
        ? await this.storageService.presignGetObject(video.thumbnail_key, {
            audience: 'public',
          })
        : null,
      processingError: video.processing_error,
      createdAt: video.created_at.toISOString(),
      updatedAt: video.updated_at.toISOString(),
    };
  }

  /**
   * The API only signs the URL: the client fetches the bytes from storage, so
   * `Range` / `206` for streaming is answered by storage itself (per TD-08).
   */
  async getDeliveryUrl(
    userId: string,
    slug: string,
    mode: VideoDeliveryMode,
  ): Promise<DeliveryUrlResponseDto> {
    const video = await this.findOwnedBySlug(userId, slug);

    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    const url = await this.storageService.presignGetObject(video.storage_key, {
      audience: 'public',
      ...(mode === VIDEO_DELIVERY_MODES.DOWNLOAD && {
        disposition: `attachment; filename="${escapeFileName(video.original_file_name)}"`,
      }),
    });

    return {
      url,
      expiresAt: this.expiresAt(this.storageService.downloadUrlTtlSeconds),
    };
  }

  async completeUpload(
    userId: string,
    slug: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.findOwnedBySlug(userId, slug);

    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotInDraftException();
    }
    this.assertPartsCoverUpload(video, dto);

    const uploadId = video.upload_id;
    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        uploadId,
        dto.parts.map((part) => ({
          partNumber: part.partNumber,
          etag: part.etag,
        })),
      );
    } catch (error) {
      if (error instanceof MultipartCompletionError) {
        // Nothing was written yet: the video stays `draft` with its upload
        // open so the client can re-send the offending parts (per TD-02).
        throw new UploadPartsInvalidException();
      }
      throw error;
    }

    await this.assertStoredSizeMatches(video);

    await this.videoRepository.update(
      { id: video.id },
      {
        status: VideoStatus.PROCESSING,
        uploaded_at: new Date(),
        upload_id: null,
      },
    );

    try {
      await this.videoProcessingQueue.enqueueProcessVideo(video.id);
    } catch (error) {
      // The bytes are in storage but nothing will process them: put the video
      // back where the client can complete it again.
      await this.videoRepository.update(
        { id: video.id },
        {
          status: VideoStatus.DRAFT,
          uploaded_at: null,
          upload_id: uploadId,
        },
      );
      throw error;
    }

    return {
      id: video.id,
      slug: video.slug,
      status: VideoStatus.PROCESSING,
    };
  }

  /** The completed upload must list every part of `1..part_count`, exactly once. */
  private assertPartsCoverUpload(video: Video, dto: CompleteUploadDto): void {
    const partNumbers = dto.parts.map((part) => part.partNumber);
    const unique = new Set(partNumbers);
    const coversEveryPart =
      unique.size === video.part_count &&
      partNumbers.length === video.part_count &&
      partNumbers.every((partNumber) => partNumber <= video.part_count);

    if (!coversEveryPart) {
      throw new InvalidPartNumbersException(
        `parts must cover every part number from 1 to ${video.part_count}, exactly once`,
      );
    }
  }

  /**
   * The declared size is only trusted once the object exists (per TD-11): a
   * mismatch discards the upload and leaves the reason on the video.
   */
  private async assertStoredSizeMatches(video: Video): Promise<void> {
    const stored = await this.storageService.headObject(video.storage_key);
    const declared = Number(video.size_bytes);

    if (
      stored !== null &&
      stored.contentLength === declared &&
      stored.contentLength <= VIDEO_UPLOAD.MAX_SIZE_BYTES
    ) {
      return;
    }

    await this.storageService.deleteObject(video.storage_key);
    await this.videoRepository.update(
      { id: video.id },
      {
        status: VideoStatus.ERROR,
        upload_id: null,
        processing_error: `UPLOAD_SIZE_MISMATCH: declared ${declared} bytes, stored ${stored?.contentLength ?? 0} bytes`,
      },
    );
    throw new UploadSizeMismatchException();
  }

  private async persistDraft(input: {
    id: string;
    channelId: string;
    dto: InitiateUploadDto;
    storageKey: string;
    uploadId: string;
    partCount: number;
  }): Promise<Video> {
    const title = input.dto.title?.trim() || stripExtension(input.dto.fileName);

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            id: input.id,
            channel_id: input.channelId,
            slug: generateVideoSlug(),
            title,
            status: VideoStatus.DRAFT,
            original_file_name: input.dto.fileName,
            mime_type: input.dto.mimeType,
            size_bytes: String(input.dto.sizeBytes),
            storage_key: input.storageKey,
            upload_id: input.uploadId,
            part_size_bytes: VIDEO_UPLOAD.PART_SIZE_BYTES,
            part_count: input.partCount,
          }),
        );
      } catch (error) {
        if (
          !isSlugUniqueViolation(error) ||
          attempt === VIDEO_UPLOAD.SLUG_MAX_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
  }

  private async presignParts(
    storageKey: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<UploadPartUrlDto[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.presignUploadPart(
          storageKey,
          uploadId,
          partNumber,
        ),
      })),
    );
  }

  private expiresAt(ttlSeconds: number): string {
    return new Date(Date.now() + ttlSeconds * 1000).toISOString();
  }
}

/**
 * `Content-Disposition` is a header: a quote or a control character in the file
 * name would break out of the quoted string it is embedded in.
 */
function escapeFileName(fileName: string): string {
  return (
    fileName
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\"]/g, '\\$&')
  );
}

function stripExtension(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^./\\]+$/, '');
  return (withoutExtension || fileName).slice(0, 100);
}
