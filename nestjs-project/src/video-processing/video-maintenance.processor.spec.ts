import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { VideoMaintenanceProcessor } from './video-maintenance.processor';
import { VideoMaintenanceService } from './video-maintenance.service';

describe('VideoMaintenanceProcessor', () => {
  let processor: VideoMaintenanceProcessor;
  let queue: { upsertJobScheduler: jest.Mock };
  let videoMaintenanceService: { sweepAbandonedUploads: jest.Mock };

  beforeEach(async () => {
    queue = { upsertJobScheduler: jest.fn().mockResolvedValue(undefined) };
    videoMaintenanceService = {
      sweepAbandonedUploads: jest
        .fn()
        .mockResolvedValue({ abandoned: 0, failed: 0 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoMaintenanceProcessor,
        {
          provide: getQueueToken(QUEUE_NAMES.VIDEO_MAINTENANCE),
          useValue: queue,
        },
        {
          provide: VideoMaintenanceService,
          useValue: videoMaintenanceService,
        },
      ],
    }).compile();

    processor = module.get(VideoMaintenanceProcessor);
  });

  it('registers the hourly sweep scheduler on bootstrap', async () => {
    await processor.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'abandoned-upload-sweep',
      { every: 3600000 },
      { name: 'sweep-abandoned-uploads', data: {} },
    );
  });

  it('delegates the job to the maintenance service', async () => {
    await processor.process();

    expect(videoMaintenanceService.sweepAbandonedUploads).toHaveBeenCalledTimes(
      1,
    );
  });
});
