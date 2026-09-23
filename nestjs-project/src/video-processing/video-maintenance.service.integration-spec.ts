import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VIDEO_UPLOAD } from '../videos/videos.constants';
import { VideoMaintenanceService } from './video-maintenance.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const HOUR_MS = 60 * 60 * 1000;

describe('VideoMaintenanceService (integration)', () => {
  let dataSource: DataSource;
  let module: TestingModule;
  let storageService: StorageService;
  let service: VideoMaintenanceService;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelsService: ChannelsService;
  let channelId: string;

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
      ],
    }).compile();
    storageService = module.get(StorageService);

    service = new VideoMaintenanceService(videoRepository, storageService);
  });

  afterAll(async () => {
    await cleanUpOpenUploads();
    await cleanAllTables(dataSource);
    await dataSource.destroy();
    await module.close();
  });

  let userCounter = 0;

  beforeEach(async () => {
    await cleanUpOpenUploads();
    await cleanAllTables(dataSource);

    const user = await userRepository.save(
      userRepository.create({
        email: `sweep_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    channelId = (await channelsService.createChannel(user.id, user.email)).id;
  });

  async function cleanUpOpenUploads(): Promise<void> {
    for (const video of await videoRepository.find()) {
      if (video.upload_id) {
        await storageService
          .abortMultipartUpload(video.storage_key, video.upload_id)
          .catch(() => undefined);
      }
    }
  }

  /** Opens a real multipart upload in MinIO and persists the matching draft. */
  async function seedDraft(options: {
    ageMs: number;
    status?: VideoStatus;
    uploadId?: string | null;
  }): Promise<Video> {
    const id = randomUUID();
    const storageKey = `videos/${id}/original.mp4`;
    const uploadId =
      options.uploadId === undefined
        ? await storageService.createMultipartUpload(storageKey, 'video/mp4')
        : options.uploadId;

    const createdAt = new Date(Date.now() - options.ageMs);
    const video = await videoRepository.save(
      videoRepository.create({
        id,
        channel_id: channelId,
        slug: id.replace(/-/g, '').slice(0, 11),
        title: 'abandoned',
        status: options.status ?? VideoStatus.DRAFT,
        original_file_name: 'abandoned.mp4',
        mime_type: 'video/mp4',
        size_bytes: '1024',
        storage_key: storageKey,
        upload_id: uploadId,
        part_size_bytes: VIDEO_UPLOAD.PART_SIZE_BYTES,
        part_count: 1,
      }),
    );

    // `created_at` is generated, so the age is applied with a direct update.
    await videoRepository.update({ id }, { created_at: createdAt });
    return video;
  }

  it('abandons a draft whose upload has been open for more than 24h', async () => {
    const video = await seedDraft({ ageMs: 25 * HOUR_MS });
    const uploadId = video.upload_id!;

    const result = await service.sweepAbandonedUploads();

    expect(result).toEqual({ abandoned: 1, failed: 0 });
    const swept = await videoRepository.findOneByOrFail({ id: video.id });
    expect(swept.status).toBe(VideoStatus.ERROR);
    expect(swept.processing_error).toBe('UPLOAD_ABANDONED');
    expect(swept.upload_id).toBeNull();

    // The multipart upload really is gone: completing it now fails.
    await expect(
      storageService.completeMultipartUpload(video.storage_key, uploadId, [
        { partNumber: 1, etag: '"abc"' },
      ]),
    ).rejects.toThrow();
  });

  it('leaves recent drafts and videos outside draft untouched', async () => {
    const recent = await seedDraft({ ageMs: 1 * HOUR_MS });
    const processing = await seedDraft({
      ageMs: 30 * HOUR_MS,
      status: VideoStatus.PROCESSING,
    });
    const completed = await seedDraft({
      ageMs: 30 * HOUR_MS,
      status: VideoStatus.DRAFT,
      uploadId: null,
    });

    const result = await service.sweepAbandonedUploads();

    expect(result).toEqual({ abandoned: 0, failed: 0 });
    for (const video of [recent, processing, completed]) {
      const untouched = await videoRepository.findOneByOrFail({
        id: video.id,
      });
      expect(untouched.status).toBe(video.status);
      expect(untouched.processing_error).toBeNull();
    }
  });

  it('treats an upload already aborted in storage as abandoned', async () => {
    const video = await seedDraft({ ageMs: 25 * HOUR_MS });
    await storageService.abortMultipartUpload(
      video.storage_key,
      video.upload_id!,
    );

    const result = await service.sweepAbandonedUploads();

    expect(result).toEqual({ abandoned: 1, failed: 0 });
    const swept = await videoRepository.findOneByOrFail({ id: video.id });
    expect(swept.status).toBe(VideoStatus.ERROR);
    expect(swept.processing_error).toBe('UPLOAD_ABANDONED');
  });

  it('keeps sweeping after one video fails', async () => {
    const failing = await seedDraft({ ageMs: 25 * HOUR_MS });
    const healthy = await seedDraft({ ageMs: 25 * HOUR_MS });
    // Only the first abort fails; the spy falls back to the real
    // implementation for the second video.
    jest
      .spyOn(storageService, 'abortMultipartUpload')
      .mockImplementationOnce(() =>
        Promise.reject(new Error('storage is down')),
      );

    const result = await service.sweepAbandonedUploads();

    expect(result.abandoned + result.failed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.abandoned).toBe(1);

    const rows = await Promise.all(
      [failing.id, healthy.id].map((id) =>
        videoRepository.findOneByOrFail({ id }),
      ),
    );
    expect(rows.filter((row) => row.status === VideoStatus.ERROR)).toHaveLength(
      1,
    );
    expect(rows.filter((row) => row.status === VideoStatus.DRAFT)).toHaveLength(
      1,
    );

    jest.restoreAllMocks();
  });
});
