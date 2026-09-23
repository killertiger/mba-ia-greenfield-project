import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Job, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import {
  ProcessVideoJobData,
  VideoProcessingQueue,
} from './video-processing.queue';

describe('VideoProcessingQueue (integration)', () => {
  let module: TestingModule;
  let producer: VideoProcessingQueue;
  let queue: Queue<ProcessVideoJobData>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
      providers: [VideoProcessingQueue],
    }).compile();

    producer = module.get(VideoProcessingQueue);
    queue = module.get<Queue<ProcessVideoJobData>>(
      getQueueToken(QUEUE_NAMES.VIDEO_PROCESSING),
    );
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it('should enqueue process-video with the retry policy and the video id as job id', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessVideo(videoId);

    // Looked up by id rather than by queue state: the video-worker container
    // may already have picked the job up when the suite runs with the full
    // environment running.
    const job: Job<ProcessVideoJobData> | undefined =
      await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(JOB_NAMES.PROCESS_VIDEO);
    expect(job!.data).toEqual({ videoId });
    expect(job!.id).toBe(videoId);
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({
      type: 'exponential',
      delay: 5000,
    });
  });

  it('should not create a second job for the same video id', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessVideo(videoId);
    await producer.enqueueProcessVideo(videoId);

    // Counted across every state, for the same reason as above.
    await expect(queue.getJobs()).resolves.toHaveLength(1);
  });
});
