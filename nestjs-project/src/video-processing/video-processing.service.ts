import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { MediaProbeService, ProbeResult } from '../media/media-probe.service';
import { MediaCommandError } from '../media/media.errors';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  ALLOWED_CONTAINER_TOKENS,
  PROCESSING_ERROR_PREFIXES,
  THUMBNAIL,
} from './video-processing.constants';

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaProbeService: MediaProbeService,
  ) {}

  /**
   * Delivery is at-least-once, so this must be idempotent: a video that is
   * already `ready` is left untouched.
   */
  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new UnrecoverableError(`Video ${videoId} no longer exists`);
    }
    if (video.status === VideoStatus.READY) {
      this.logger.log(`Video ${videoId} is already ready, skipping`);
      return;
    }

    // ffprobe reads the original straight from storage — no local copy.
    const sourceUrl = await this.storageService.presignGetObject(
      video.storage_key,
      { audience: 'internal' },
    );
    const probe = await this.probeOrReject(sourceUrl);
    this.assertPlayableVideo(probe);

    const thumbnailKey = await this.storeThumbnail(video, sourceUrl, probe);

    await this.videoRepository.update(
      { id: video.id },
      {
        status: VideoStatus.READY,
        duration_seconds:
          probe.durationSeconds === null ? null : String(probe.durationSeconds),
        width: probe.width,
        height: probe.height,
        // TypeORM's deep-partial type cannot express an arbitrary jsonb value.
        metadata: probe.metadata as QueryDeepPartialEntity<Video>['metadata'],
        thumbnail_key: thumbnailKey,
        processing_error: null,
      },
    );
  }

  /**
   * A non-zero exit means ffprobe read the input and refused it — the file is
   * not media, and retrying would fail identically. A `null` exit code (the
   * binary could not be spawned, or timed out) stays retryable.
   */
  private async probeOrReject(sourceUrl: string): Promise<ProbeResult> {
    try {
      return await this.mediaProbeService.probe(sourceUrl);
    } catch (error) {
      if (error instanceof MediaCommandError && error.exitCode !== null) {
        throw new UnrecoverableError(
          `${PROCESSING_ERROR_PREFIXES.UNSUPPORTED_MEDIA}: ${error.message}`,
        );
      }
      throw error;
    }
  }

  /** Neither a missing video stream nor a foreign container is retryable. */
  private assertPlayableVideo(probe: ProbeResult): void {
    if (!probe.hasVideoStream) {
      throw new UnrecoverableError(
        `${PROCESSING_ERROR_PREFIXES.UNSUPPORTED_MEDIA}: no video stream found`,
      );
    }

    const formatName = probe.formatName ?? '';
    const isAllowed = ALLOWED_CONTAINER_TOKENS.some((token) =>
      formatName.includes(token),
    );
    if (!isAllowed) {
      throw new UnrecoverableError(
        `${PROCESSING_ERROR_PREFIXES.UNSUPPORTED_MEDIA}: container "${formatName}" is not supported`,
      );
    }
  }

  private async storeThumbnail(
    video: Video,
    sourceUrl: string,
    probe: ProbeResult,
  ): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), `video-${video.id}-`));
    const localPath = join(directory, THUMBNAIL.FILE_NAME);
    const duration = probe.durationSeconds ?? 0;
    const position = Math.min(duration * THUMBNAIL.POSITION_RATIO, duration);

    try {
      await this.mediaProbeService.extractFrame(sourceUrl, position, localPath);
      const key = `videos/${video.id}/${THUMBNAIL.FILE_NAME}`;
      await this.storageService.putObject(
        key,
        await readFile(localPath),
        THUMBNAIL.CONTENT_TYPE,
      );
      return key;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
