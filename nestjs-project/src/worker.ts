import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

/**
 * Worker entrypoint: an application context, not an HTTP server — it listens
 * on the queue only. Shutdown hooks let BullMQ finish the job in flight and
 * close the Redis/Postgres connections on SIGTERM.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log('Video worker started', 'Worker');
}

void bootstrap();
