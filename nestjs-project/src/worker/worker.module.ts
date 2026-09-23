import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { DatabaseModule } from '../database/database.module';
import { UsersModule } from '../users/users.module';
import { VideoProcessingModule } from '../video-processing/video-processing.module';

/**
 * Root module of the worker process: same code as the API, minus the HTTP
 * layer and everything it needs (controllers, mailer, Swagger, auth).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    DatabaseModule,
    // `autoLoadEntities` only sees entities registered by the modules in this
    // graph, and `Video` relates to `Channel`, which relates to `User`. Each
    // entity stays registered by its owning module.
    UsersModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
