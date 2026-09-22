import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { LessThan, Not, IsNull, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  ABANDONED_UPLOAD,
  PROCESSING_ERROR_PREFIXES,
} from './video-processing.constants';

export interface SweepResult {
  abandoned: number;
  failed: number;
}

@Injectable()
export class VideoMaintenanceService {
  private readonly logger = new Logger(VideoMaintenanceService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Drafts whose upload was never completed keep multipart parts allocated in
   * storage. One failing video must not stop the sweep, and re-running it is
   * harmless: the query only matches drafts that still have an open upload.
   */
  async sweepAbandonedUploads(now: Date = new Date()): Promise<SweepResult> {
    const cutoff = new Date(now.getTime() - ABANDONED_UPLOAD.MAX_AGE_MS);
    const abandonedDrafts = await this.videoRepository.find({
      where: {
        status: VideoStatus.DRAFT,
        upload_id: Not(IsNull()),
        created_at: LessThan(cutoff),
      },
    });

    let abandoned = 0;
    let failed = 0;

    for (const video of abandonedDrafts) {
      try {
        await this.abortUpload(video);
        await this.videoRepository.update(
          { id: video.id },
          {
            status: VideoStatus.ERROR,
            upload_id: null,
            processing_error: PROCESSING_ERROR_PREFIXES.UPLOAD_ABANDONED,
          },
        );
        abandoned++;
      } catch (error) {
        failed++;
        this.logger.error(
          `Could not abandon the upload of video ${video.id}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    if (abandoned > 0 || failed > 0) {
      this.logger.log(
        `Abandoned-upload sweep: ${abandoned} cleaned up, ${failed} failed`,
      );
    }
    return { abandoned, failed };
  }

  private async abortUpload(video: Video): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id!,
      );
    } catch (error) {
      // The upload is already gone from storage — which is the desired state.
      if (
        error instanceof S3ServiceException &&
        error.name === 'NoSuchUpload'
      ) {
        return;
      }
      throw error;
    }
  }
}
