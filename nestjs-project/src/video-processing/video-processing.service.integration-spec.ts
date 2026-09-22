import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { MediaModule } from '../media/media.module';
import { MediaProbeService } from '../media/media-probe.service';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VIDEO_UPLOAD } from '../videos/videos.constants';
import {
  createSampleVideo,
  removeSampleVideo,
  SampleVideo,
} from '../../test/fixtures/sample-video';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingService (integration)', () => {
  let dataSource: DataSource;
  let module: TestingModule;
  let storageService: StorageService;
  let service: VideoProcessingService;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelsService: ChannelsService;
  let sample: SampleVideo;

  const storedKeys: string[] = [];

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelsService = new ChannelsService(dataSource);

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
        MediaModule,
      ],
    }).compile();
    storageService = module.get(StorageService);

    service = new VideoProcessingService(
      videoRepository,
      storageService,
      module.get(MediaProbeService),
    );

    sample = await createSampleVideo();
  }, 60000);

  afterAll(async () => {
    await Promise.all(
      storedKeys.map((key) => storageService.deleteObject(key)),
    );
    await cleanAllTables(dataSource);
    await dataSource.destroy();
    await module.close();
    await removeSampleVideo(sample);
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;

  /** Uploads `body` as the video's original file and returns the saved row. */
  async function seedVideo(
    body: Buffer,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `worker_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);

    const id = randomUUID();
    const storageKey = `videos/${id}/original.mp4`;
    await storageService.putObject(storageKey, body, 'video/mp4');
    storedKeys.push(storageKey, `videos/${id}/thumbnail.jpg`);

    return videoRepository.save(
      videoRepository.create({
        id,
        channel_id: channel.id,
        slug: id.replace(/-/g, '').slice(0, 11),
        title: 'holiday',
        status: VideoStatus.PROCESSING,
        original_file_name: 'holiday.mp4',
        mime_type: 'video/mp4',
        size_bytes: String(body.length),
        storage_key: storageKey,
        part_size_bytes: VIDEO_UPLOAD.PART_SIZE_BYTES,
        part_count: 1,
        uploaded_at: new Date(),
        ...overrides,
      }),
    );
  }

  it('persists metadata and the thumbnail, then marks the video ready', async () => {
    const video = await seedVideo(await readFile(sample.path));

    await service.process(video.id);

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(Number(processed.duration_seconds)).toBeCloseTo(
      sample.durationSeconds,
      1,
    );
    expect(processed.width).toBe(sample.width);
    expect(processed.height).toBe(sample.height);
    expect(processed.metadata).toMatchObject({
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
    expect(processed.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(processed.processing_error).toBeNull();

    const thumbnail = await storageService.headObject(processed.thumbnail_key!);
    expect(thumbnail).not.toBeNull();
    expect(thumbnail!.contentLength).toBeGreaterThan(0);
  }, 60000);

  it('leaves an already ready video untouched', async () => {
    const video = await seedVideo(await readFile(sample.path), {
      status: VideoStatus.READY,
      thumbnail_key: 'videos/kept/thumbnail.jpg',
    });

    await service.process(video.id);

    const untouched = await videoRepository.findOneByOrFail({ id: video.id });
    expect(untouched.status).toBe(VideoStatus.READY);
    expect(untouched.thumbnail_key).toBe('videos/kept/thumbnail.jpg');
    expect(untouched.duration_seconds).toBeNull();
    expect(untouched.width).toBeNull();
  });

  it('rejects an object that is not a video without retrying', async () => {
    const video = await seedVideo(Buffer.from('this is not a video at all'));

    await expect(service.process(video.id)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const untouched = await videoRepository.findOneByOrFail({ id: video.id });
    expect(untouched.status).toBe(VideoStatus.PROCESSING);
  }, 60000);

  it('rejects a video that no longer exists', async () => {
    await expect(service.process(randomUUID())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});
