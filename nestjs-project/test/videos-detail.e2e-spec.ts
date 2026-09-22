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
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_UPLOAD } from '../src/videos/videos.constants';
import {
  AuthenticatedUser,
  createAuthenticatedUser,
} from './helpers/authenticated-user';

interface InitiateUploadBody {
  id: string;
  slug: string;
}

interface VideoBody {
  id: string;
  slug: string;
  title: string;
  status: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  metadata: Record<string, unknown> | null;
  thumbnailUrl: string | null;
  processingError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Smallest valid JPEG: a 1x1 pixel, enough for a Content-Type assertion. */
const ONE_PIXEL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

describe('GET /videos/:slug (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let owner: AuthenticatedUser;
  let otherUser: AuthenticatedUser;

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
    // Created once per file: /auth is throttled to 10 req/min.
    owner = await createAuthenticatedUser(app, 'detail-owner@streamtube.local');
    otherUser = await createAuthenticatedUser(
      app,
      'detail-other@streamtube.local',
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
      if (video.thumbnail_key) {
        await storageService.deleteObject(video.thumbnail_key);
      }
    }
    await dataSource.query('DELETE FROM "videos"');
  }

  async function createDraft(
    body: Record<string, unknown> = {
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1024,
    },
  ): Promise<InitiateUploadBody> {
    const response = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send(body)
      .expect(201);
    return response.body as InitiateUploadBody;
  }

  function getVideo(slug: string, user: AuthenticatedUser = owner) {
    return request(app.getHttpServer())
      .get(`/videos/${slug}`)
      .set('Authorization', `Bearer ${user.accessToken}`);
  }

  describe('Video state by lifecycle stage', () => {
    it('returns a fresh draft with no processing data', async () => {
      const draft = await createDraft();

      const response = await getVideo(draft.slug).expect(200);

      const body = response.body as VideoBody;
      expect(body.id).toBe(draft.id);
      expect(body.status).toBe('draft');
      expect(body.title).toBe('clip');
      expect(body.mimeType).toBe('video/mp4');
      expect(body.sizeBytes).toBe(1024);
      expect(body.durationSeconds).toBeNull();
      expect(body.width).toBeNull();
      expect(body.height).toBeNull();
      expect(body.metadata).toBeNull();
      expect(body.thumbnailUrl).toBeNull();
      expect(body.processingError).toBeNull();
      expect(Date.parse(body.createdAt)).not.toBeNaN();
    });

    it('returns a ready video with metadata and a working thumbnail URL', async () => {
      // Arranged directly so this spec does not depend on the worker; the
      // worker-driven path is covered by the pipeline spec (SI-03.14).
      const draft = await createDraft();
      const thumbnailKey = `videos/${draft.id}/thumbnail.jpg`;
      await storageService.putObject(
        thumbnailKey,
        ONE_PIXEL_JPEG,
        'image/jpeg',
      );
      await dataSource.getRepository(Video).update(
        { id: draft.id },
        {
          status: VideoStatus.READY,
          duration_seconds: '2.000',
          width: 320,
          height: 240,
          metadata: { videoCodec: 'h264' },
          thumbnail_key: thumbnailKey,
          upload_id: null,
        },
      );

      const response = await getVideo(draft.slug).expect(200);

      const body = response.body as VideoBody;
      expect(body.status).toBe('ready');
      expect(body.durationSeconds).toBe(2);
      expect(body.width).toBe(320);
      expect(body.height).toBe(240);
      expect(body.metadata).toEqual({ videoCodec: 'h264' });
      expect(body.thumbnailUrl).toBeTruthy();

      const thumbnail = await fetch(body.thumbnailUrl!);
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
    });

    it('returns the processing error of a failed video', async () => {
      const draft = await createDraft();
      await dataSource.getRepository(Video).update(
        { id: draft.id },
        {
          status: VideoStatus.ERROR,
          processing_error: 'UNSUPPORTED_MEDIA: no video stream',
          upload_id: null,
        },
      );

      const response = await getVideo(draft.slug).expect(200);

      const body = response.body as VideoBody;
      expect(body.status).toBe('error');
      expect(body.processingError).toBe('UNSUPPORTED_MEDIA: no video stream');
    });

    it('returns a size above 2^31 as a JSON number', async () => {
      const draft = await createDraft({
        fileName: 'max.mp4',
        mimeType: 'video/mp4',
        sizeBytes: VIDEO_UPLOAD.MAX_SIZE_BYTES,
      });

      const response = await getVideo(draft.slug).expect(200);

      const body = response.body as VideoBody;
      expect(body.sizeBytes).toBe(VIDEO_UPLOAD.MAX_SIZE_BYTES);
      expect(typeof body.sizeBytes).toBe('number');
    });
  });

  describe('Ownership', () => {
    it('hides the video from a non-owner and rejects a malformed slug', async () => {
      const draft = await createDraft();

      const foreign = await getVideo(draft.slug, otherUser).expect(404);
      expect((foreign.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');

      const malformed = await getVideo('not-a-slug').expect(404);
      expect((malformed.body as { error: string }).error).toBe(
        'VIDEO_NOT_FOUND',
      );
    });
  });
});
