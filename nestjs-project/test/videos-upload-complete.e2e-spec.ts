import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { QUEUE_NAMES } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { StorageService } from '../src/storage/storage.service';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  AuthenticatedUser,
  createAuthenticatedUser,
} from './helpers/authenticated-user';

interface InitiateUploadBody {
  id: string;
  slug: string;
  partCount: number;
  parts: { partNumber: number; url: string }[];
}

interface CompleteUploadBody {
  id: string;
  slug: string;
  status: string;
}

describe('POST /videos/:slug/upload/complete (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let processingQueue: Queue;
  let user: AuthenticatedUser;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storageService = moduleFixture.get(StorageService);
    processingQueue = moduleFixture.get<Queue>(
      getQueueToken(QUEUE_NAMES.VIDEO_PROCESSING),
    );

    await cleanAllTables(dataSource);
    // Created once per file: /auth is throttled to 10 req/min.
    user = await createAuthenticatedUser(
      app,
      'upload-complete@streamtube.local',
    );
  });

  afterAll(async () => {
    await cleanUp();
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(async () => {
    await cleanUp();
  });

  async function cleanUp(): Promise<void> {
    const videos = await dataSource.getRepository(Video).find();
    for (const video of videos) {
      if (video.upload_id) {
        await storageService.abortMultipartUpload(
          video.storage_key,
          video.upload_id,
        );
      }
      await storageService.deleteObject(video.storage_key);
    }
    await dataSource.query('DELETE FROM "videos"');
    await processingQueue.obliterate({ force: true });
  }

  /**
   * A single-part upload: the last (and only) part of a multipart upload has
   * no minimum size, so 1 KiB is enough to exercise the whole flow.
   */
  async function uploadSinglePart(
    bytes = 1024,
    declaredSize = 1024,
  ): Promise<{ draft: InitiateUploadBody; etag: string }> {
    const response = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: declaredSize,
      })
      .expect(201);

    const draft = response.body as InitiateUploadBody;
    expect(draft.partCount).toBe(1);

    const uploaded = await fetch(draft.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(bytes, 5)),
    });
    expect(uploaded.status).toBe(200);

    return { draft, etag: uploaded.headers.get('etag')! };
  }

  function completeUpload(slug: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/videos/${slug}/upload/complete`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send(body);
  }

  describe('Successful completion', () => {
    it('completes the upload and moves the video to processing', async () => {
      const { draft, etag } = await uploadSinglePart();

      const response = await completeUpload(draft.slug, {
        parts: [{ partNumber: 1, etag }],
      }).expect(202);

      expect(response.body as CompleteUploadBody).toEqual({
        id: draft.id,
        slug: draft.slug,
        status: 'processing',
      });

      const persisted = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: draft.id });
      expect(persisted.status).toBe(VideoStatus.PROCESSING);
      expect(persisted.uploaded_at).not.toBeNull();
      expect(persisted.upload_id).toBeNull();
    });

    it('enqueues one process-video job keyed by the video id', async () => {
      const { draft, etag } = await uploadSinglePart();

      await completeUpload(draft.slug, {
        parts: [{ partNumber: 1, etag }],
      }).expect(202);

      const jobs = await processingQueue.getJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe('process-video');
      expect(jobs[0].id).toBe(draft.id);
      expect(jobs[0].data).toEqual({ videoId: draft.id });
    });

    it('rejects a repeated complete without enqueuing a second job', async () => {
      const { draft, etag } = await uploadSinglePart();
      const body = { parts: [{ partNumber: 1, etag }] };

      await completeUpload(draft.slug, body).expect(202);

      const repeated = await completeUpload(draft.slug, body).expect(409);
      expect((repeated.body as { error: string }).error).toBe(
        'VIDEO_NOT_IN_DRAFT',
      );

      const jobs = await processingQueue.getJobs();
      expect(jobs).toHaveLength(1);
    });
  });

  describe('Rejected completion', () => {
    it('keeps the video as a draft when an ETag is invalid', async () => {
      const { draft } = await uploadSinglePart();

      const response = await completeUpload(draft.slug, {
        parts: [{ partNumber: 1, etag: '"00000000000000000000000000000000"' }],
      }).expect(422);

      expect((response.body as { error: string }).error).toBe(
        'UPLOAD_PARTS_INVALID',
      );

      const persisted = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: draft.id });
      expect(persisted.status).toBe(VideoStatus.DRAFT);
      expect(persisted.upload_id).not.toBeNull();
    });

    it('discards the object and marks the video as error on a size mismatch', async () => {
      const { draft, etag } = await uploadSinglePart(512, 1024);

      const response = await completeUpload(draft.slug, {
        parts: [{ partNumber: 1, etag }],
      }).expect(422);

      expect((response.body as { error: string }).error).toBe(
        'UPLOAD_SIZE_MISMATCH',
      );

      const persisted = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: draft.id });
      expect(persisted.status).toBe(VideoStatus.ERROR);
      expect(persisted.upload_id).toBeNull();
      expect(persisted.processing_error).toMatch(/^UPLOAD_SIZE_MISMATCH/);

      await expect(
        storageService.headObject(persisted.storage_key),
      ).resolves.toBeNull();
      await expect(processingQueue.getJobs()).resolves.toHaveLength(0);
    });

    it('rejects a part set that does not cover the upload', async () => {
      const { draft } = await uploadSinglePart();

      const wrongPart = await completeUpload(draft.slug, {
        parts: [{ partNumber: 2, etag: '"abc"' }],
      }).expect(400);
      expect((wrongPart.body as { error: string }).error).toBe(
        'VALIDATION_ERROR',
      );

      const empty = await completeUpload(draft.slug, { parts: [] }).expect(400);
      expect((empty.body as { error: string }).error).toBe('VALIDATION_ERROR');
    });
  });
});
