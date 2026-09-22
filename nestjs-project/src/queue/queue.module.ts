import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { QUEUE_NAMES } from './queue.constants';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (queue: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: queue.redisHost,
          port: queue.redisPort,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.VIDEO_PROCESSING },
      { name: QUEUE_NAMES.VIDEO_MAINTENANCE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
