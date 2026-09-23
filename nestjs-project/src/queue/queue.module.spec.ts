import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QUEUE_NAMES } from './queue.constants';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  it('should compile and register both queues', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    const processing = module.get<Queue>(
      getQueueToken(QUEUE_NAMES.VIDEO_PROCESSING),
    );
    const maintenance = module.get<Queue>(
      getQueueToken(QUEUE_NAMES.VIDEO_MAINTENANCE),
    );

    expect(processing.name).toBe(QUEUE_NAMES.VIDEO_PROCESSING);
    expect(maintenance.name).toBe(QUEUE_NAMES.VIDEO_MAINTENANCE);
    await module.close();
  });
});
