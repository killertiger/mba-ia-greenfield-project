import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { ProcessVideoJobData } from '../videos/video-processing.queue';
import { PROCESSING_ERROR_PREFIXES } from './video-processing.constants';
import { VideoProcessingService } from './video-processing.service';

@Processor(QUEUE_NAMES.VIDEO_PROCESSING)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    private readonly videoProcessingService: VideoProcessingService,
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    await this.videoProcessingService.process(job.data.videoId);
  }

  /**
   * The video is only marked as failed once no retry is left — an intermediate
   * attempt keeps it `processing` (per TD-09). This runs in the worker's event
   * loop, outside the request lifecycle, so it logs instead of rethrowing.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>, error: Error): Promise<void> {
    const unrecoverable = error instanceof UnrecoverableError;
    const attempts = job.opts.attempts ?? 1;
    const isLastAttempt = job.attemptsMade >= attempts;

    if (!unrecoverable && !isLastAttempt) {
      this.logger.warn(
        `Attempt ${job.attemptsMade}/${attempts} failed for video ${job.data.videoId}: ${error.message}`,
      );
      return;
    }

    const processingError = unrecoverable
      ? error.message
      : `${PROCESSING_ERROR_PREFIXES.PROCESSING_FAILED}: ${error.message}`;

    try {
      await this.videoRepository.update(
        { id: job.data.videoId },
        { status: VideoStatus.ERROR, processing_error: processingError },
      );
      this.logger.error(
        `Video ${job.data.videoId} failed permanently: ${processingError}`,
      );
    } catch (updateError) {
      this.logger.error(
        `Could not record the failure of video ${job.data.videoId}`,
        updateError instanceof Error ? updateError.stack : undefined,
      );
    }
  }
}
