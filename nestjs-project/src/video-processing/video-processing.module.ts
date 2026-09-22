import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaModule } from '../media/media.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';
import { VideoMaintenanceProcessor } from './video-maintenance.processor';
import { VideoMaintenanceService } from './video-maintenance.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    QueueModule,
    StorageModule,
    MediaModule,
  ],
  providers: [
    VideoProcessingService,
    VideoProcessingProcessor,
    VideoMaintenanceService,
    VideoMaintenanceProcessor,
  ],
  exports: [VideoProcessingService, VideoMaintenanceService],
})
export class VideoProcessingModule {}
