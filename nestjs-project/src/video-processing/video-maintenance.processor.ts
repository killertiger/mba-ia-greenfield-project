import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  SCHEDULER_IDS,
} from '../queue/queue.constants';
import { ABANDONED_UPLOAD } from './video-processing.constants';
import { VideoMaintenanceService } from './video-maintenance.service';

@Processor(QUEUE_NAMES.VIDEO_MAINTENANCE)
export class VideoMaintenanceProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(VideoMaintenanceProcessor.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.VIDEO_MAINTENANCE)
    private readonly queue: Queue,
    private readonly videoMaintenanceService: VideoMaintenanceService,
  ) {
    super();
  }

  /**
   * `upsertJobScheduler` is keyed by the scheduler id, so restarting the
   * worker updates the existing schedule instead of adding another one.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SCHEDULER_IDS.ABANDONED_UPLOAD_SWEEP,
      { every: ABANDONED_UPLOAD.SWEEP_INTERVAL_MS },
      { name: JOB_NAMES.SWEEP_ABANDONED_UPLOADS, data: {} },
    );
    this.logger.log(
      `Scheduled "${SCHEDULER_IDS.ABANDONED_UPLOAD_SWEEP}" every ${ABANDONED_UPLOAD.SWEEP_INTERVAL_MS}ms`,
    );
  }

  async process(): Promise<void> {
    await this.videoMaintenanceService.sweepAbandonedUploads();
  }
}
