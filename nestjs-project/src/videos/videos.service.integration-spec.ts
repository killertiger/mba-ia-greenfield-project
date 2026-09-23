import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingQueue } from './video-processing.queue';
import { VideosService } from './videos.service';
import { VIDEO_SLUG, VIDEO_UPLOAD } from './videos.constants';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let module: TestingModule;
  let storageService: StorageService;
  let videosService: VideosService;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelsService: ChannelsService;
  let processingQueue: Queue;

  const openUploads: { key: string; uploadId: string }[] = [];
  const storedKeys: string[] = [];

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelsService = new ChannelsService(dataSource);

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        StorageModule,
        QueueModule,
      ],
      providers: [VideoProcessingQueue],
    }).compile();
    storageService = module.get(StorageService);
    processingQueue = module.get<Queue>(
      getQueueToken(QUEUE_NAMES.VIDEO_PROCESSING),
    );

    videosService = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      module.get(VideoProcessingQueue),
    );
  });

  afterAll(async () => {
    await Promise.all(
      openUploads.map(({ key, uploadId }) =>
        storageService.abortMultipartUpload(key, uploadId),
      ),
    );
    await Promise.all(
      storedKeys.map((key) => storageService.deleteObject(key)),
    );
    await cleanAllTables(dataSource);
    await dataSource.destroy();
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await processingQueue.obliterate({ force: true });
  });

  let userCounter = 0;
  async function createUserWithChannel(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);
    return { userId: user.id, channelId: channel.id };
  }

  const dto = {
    fileName: 'holiday.mp4',
    mimeType: 'video/mp4' as const,
    sizeBytes: VIDEO_UPLOAD.PART_SIZE_BYTES * 2,
  };

  it('persists the draft and opens a real multipart upload', async () => {
    const { userId, channelId } = await createUserWithChannel();

    const result = await videosService.initiateUpload(userId, dto);

    const persisted = await videoRepository.findOneByOrFail({ id: result.id });
    openUploads.push({
      key: persisted.storage_key,
      uploadId: persisted.upload_id!,
    });

    expect(persisted.channel_id).toBe(channelId);
    expect(persisted.status).toBe(VideoStatus.DRAFT);
    expect(persisted.slug).toMatch(VIDEO_SLUG.PATTERN);
    expect(persisted.size_bytes).toBe(String(dto.sizeBytes));
    expect(persisted.mime_type).toBe('video/mp4');
    expect(persisted.original_file_name).toBe('holiday.mp4');
    expect(persisted.storage_key).toBe(`videos/${result.id}/original.mp4`);
    expect(persisted.upload_id).toBeTruthy();
    expect(persisted.part_count).toBe(2);
    expect(persisted.uploaded_at).toBeNull();
    expect(persisted.duration_seconds).toBeNull();

    // The upload really exists in storage: aborting it succeeds and the
    // object was never materialized.
    await storageService.abortMultipartUpload(
      persisted.storage_key,
      persisted.upload_id!,
    );
    openUploads.pop();
    await expect(
      storageService.headObject(persisted.storage_key),
    ).resolves.toBeNull();
  });

  it('enforces the unique slug across videos of different channels', async () => {
    const first = await createUserWithChannel();
    const second = await createUserWithChannel();

    const one = await videosService.initiateUpload(first.userId, dto);
    const two = await videosService.initiateUpload(second.userId, dto);

    for (const id of [one.id, two.id]) {
      const video = await videoRepository.findOneByOrFail({ id });
      openUploads.push({ key: video.storage_key, uploadId: video.upload_id! });
    }

    expect(one.slug).not.toBe(two.slug);
    await expect(
      videoRepository.update({ id: two.id }, { slug: one.slug }),
    ).rejects.toThrow(/duplicate key value/);
  });

  it('aborts the multipart upload when the draft cannot be persisted', async () => {
    const { userId } = await createUserWithChannel();
    const saveSpy = jest
      .spyOn(videoRepository, 'save')
      .mockRejectedValue(new Error('persistence failed'));
    const abortSpy = jest.spyOn(storageService, 'abortMultipartUpload');

    await expect(videosService.initiateUpload(userId, dto)).rejects.toThrow(
      'persistence failed',
    );

    expect(abortSpy).toHaveBeenCalledTimes(1);
    await expect(videoRepository.count()).resolves.toBe(0);

    saveSpy.mockRestore();
    abortSpy.mockRestore();
  });

  describe('completeUpload', () => {
    async function putPart(url: string, body: Buffer): Promise<string> {
      const response = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(body),
      });
      expect(response.status).toBe(200);
      return response.headers.get('etag')!;
    }

    it('completes a real two-part upload and queues the processing job', async () => {
      const { userId } = await createUserWithChannel();
      // A non-final part must be at least 5 MiB, so the first part carries a
      // full PART_SIZE_BYTES and the second one a single byte.
      const initiated = await videosService.initiateUpload(userId, {
        ...dto,
        sizeBytes: VIDEO_UPLOAD.PART_SIZE_BYTES + 1,
      });
      expect(initiated.partCount).toBe(2);

      const etags = [
        await putPart(
          initiated.parts[0].url,
          Buffer.alloc(VIDEO_UPLOAD.PART_SIZE_BYTES),
        ),
        await putPart(initiated.parts[1].url, Buffer.alloc(1, 9)),
      ];

      const result = await videosService.completeUpload(
        userId,
        initiated.slug,
        {
          parts: etags.map((etag, index) => ({
            partNumber: index + 1,
            etag,
          })),
        },
      );

      expect(result.status).toBe(VideoStatus.PROCESSING);

      const persisted = await videoRepository.findOneByOrFail({
        id: initiated.id,
      });
      storedKeys.push(persisted.storage_key);

      expect(persisted.status).toBe(VideoStatus.PROCESSING);
      expect(persisted.uploaded_at).not.toBeNull();
      expect(persisted.upload_id).toBeNull();

      // The object really is the assembled file, not a single part.
      await expect(
        storageService.headObject(persisted.storage_key),
      ).resolves.toEqual({
        contentLength: VIDEO_UPLOAD.PART_SIZE_BYTES + 1,
      });

      const jobs = await processingQueue.getJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(initiated.id);
      expect(jobs[0].data).toEqual({ videoId: initiated.id });
    }, 60000);
  });
});
