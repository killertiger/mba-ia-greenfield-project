import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { StorageService } from '../src/storage/storage.service';
import { Video } from '../src/videos/entities/video.entity';
import { VIDEO_SLUG, VIDEO_UPLOAD } from '../src/videos/videos.constants';
import {
  AuthenticatedUser,
  createAuthenticatedUser,
} from './helpers/authenticated-user';

interface InitiateUploadBody {
  id: string;
  slug: string;
  title: string;
  status: string;
  partSizeBytes: number;
  partCount: number;
  parts: { partNumber: number; url: string }[];
  partUrlsExpireAt: string;
}

describe('POST /videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
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

    await cleanAllTables(dataSource);
    // Created once per file: the global ThrottlerGuard caps /auth at 10 req/min.
    user = await createAuthenticatedUser(app, 'videos-upload@streamtube.local');
  });

  afterAll(async () => {
    await abortOpenUploads();
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(async () => {
    await abortOpenUploads();
  });

  /** Multipart uploads left open in MinIO keep storage allocated — abort them. */
  async function abortOpenUploads(): Promise<void> {
    const videos = await dataSource.getRepository(Video).find();
    for (const video of videos) {
      if (video.upload_id) {
        await storageService.abortMultipartUpload(
          video.storage_key,
          video.upload_id,
        );
      }
    }
    await dataSource.query('DELETE FROM "videos"');
  }

  function initiateUpload(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send(body);
  }

  describe('Upload initiation', () => {
    it('initiates the upload and returns one presigned URL per part', async () => {
      const before = Date.now();

      const response = await initiateUpload({
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 209715200,
      }).expect(201);

      const body = response.body as InitiateUploadBody;
      expect(body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(body.slug).toMatch(VIDEO_SLUG.PATTERN);
      expect(body.title).toBe('clip');
      expect(body.status).toBe('draft');
      expect(body.partSizeBytes).toBe(VIDEO_UPLOAD.PART_SIZE_BYTES);
      expect(body.partCount).toBe(2);
      expect(body.parts).toHaveLength(2);
      expect(body.parts.map((part) => part.partNumber)).toEqual([1, 2]);
      for (const part of body.parts) {
        expect(part.url).toContain(`partNumber=${part.partNumber}`);
      }
      expect(Date.parse(body.partUrlsExpireAt)).toBeGreaterThan(before);
    });

    it('persists the draft with the multipart upload still open', async () => {
      const response = await initiateUpload({
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 209715200,
      }).expect(201);

      const { id } = response.body as InitiateUploadBody;
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id });

      expect(video.status).toBe('draft');
      expect(video.channel_id).toBe(user.channelId);
      expect(video.upload_id).not.toBeNull();
      expect(video.title).toBe('clip');
      expect(video.part_size_bytes).toBe(VIDEO_UPLOAD.PART_SIZE_BYTES);
      expect(video.part_count).toBe(2);
      expect(video.storage_key).toBe(`videos/${id}/original.mp4`);
    });

    it('accepts the file bytes directly on the presigned part URL', async () => {
      const response = await initiateUpload({
        fileName: 'small.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
      }).expect(201);

      const body = response.body as InitiateUploadBody;
      expect(body.partCount).toBe(1);

      // The API is not involved here: the bytes go straight to MinIO.
      const uploaded = await fetch(body.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(1024, 7)),
      });

      expect(uploaded.status).toBe(200);
      expect(uploaded.headers.get('etag')).toBeTruthy();
    });
  });

  describe('Validation and authentication', () => {
    it('rejects an unsupported mime type', async () => {
      const response = await initiateUpload({
        fileName: 'clip.avi',
        mimeType: 'video/x-msvideo',
        sizeBytes: 1024,
      }).expect(400);

      expect((response.body as { error: string }).error).toBe(
        'VALIDATION_ERROR',
      );
      await expect(dataSource.getRepository(Video).count()).resolves.toBe(0);
    });

    it('rejects a size above the limit and accepts the limit itself', async () => {
      const rejected = await initiateUpload({
        fileName: 'big.mp4',
        mimeType: 'video/mp4',
        sizeBytes: VIDEO_UPLOAD.MAX_SIZE_BYTES + 1,
      }).expect(400);

      expect((rejected.body as { error: string }).error).toBe(
        'VALIDATION_ERROR',
      );

      const accepted = await initiateUpload({
        fileName: 'max.mp4',
        mimeType: 'video/mp4',
        sizeBytes: VIDEO_UPLOAD.MAX_SIZE_BYTES,
      }).expect(201);

      expect((accepted.body as InitiateUploadBody).partCount).toBe(103);
    });

    it('requires an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          fileName: 'clip.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 1024,
        })
        .expect(401);

      await expect(dataSource.getRepository(Video).count()).resolves.toBe(0);
    });
  });

  describe('Unique URL identifier', () => {
    it('assigns a distinct slug to each video', async () => {
      const body = {
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
      };

      const first = await initiateUpload(body).expect(201);
      const second = await initiateUpload(body).expect(201);

      const one = first.body as InitiateUploadBody;
      const two = second.body as InitiateUploadBody;
      expect(one.slug).not.toBe(two.slug);
      expect(one.id).not.toBe(two.id);
    });
  });
});
