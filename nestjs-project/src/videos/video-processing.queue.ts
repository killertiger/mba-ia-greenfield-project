import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  JOB_NAMES,
  PROCESS_VIDEO_JOB_OPTIONS,
  QUEUE_NAMES,
} from '../queue/queue.constants';

export interface ProcessVideoJobData {
  videoId: string;
}

@Injectable()
export class VideoProcessingQueue {
  constructor(
    @InjectQueue(QUEUE_NAMES.VIDEO_PROCESSING)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  async enqueueProcessVideo(videoId: string): Promise<void> {
    await this.queue.add(
      JOB_NAMES.PROCESS_VIDEO,
      { videoId },
      {
        jobId: videoId,
        attempts: PROCESS_VIDEO_JOB_OPTIONS.ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: PROCESS_VIDEO_JOB_OPTIONS.BACKOFF_DELAY_MS,
        },
      },
    );
  }
}
