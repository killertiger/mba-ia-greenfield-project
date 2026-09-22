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
import {
  AuthenticatedUser,
  createAuthenticatedUser,
} from './helpers/authenticated-user';

interface DeliveryBody {
  url: string;
  expiresAt: string;
}

const CONTENT_LENGTH = 4096;
/** Deterministic bytes, so a partial response can be compared exactly. */
const CONTENT = Buffer.from(
  Array.from({ length: CONTENT_LENGTH }, (_, index) => index % 251),
);

describe('GET /videos/:slug/stream and /download (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let owner: AuthenticatedUser;
  let otherUser: AuthenticatedUser;
  let video: { id: string; slug: string; storageKey: string };

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
    owner = await createAuthenticatedUser(
      app,
      'delivery-owner@streamtube.local',
    );
    otherUser = await createAuthenticatedUser(
      app,
      'delivery-other@streamtube.local',
    );
  });

  afterAll(async () => {
    await cleanUp();
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(async () => {
    await cleanUp();
    video = await arrangeReadyVideo();
  });

  async function cleanUp(): Promise<void> {
    const videos = await dataSource.getRepository(Video).find();
    for (const row of videos) {
      if (row.upload_id) {
        await storageService.abortMultipartUpload(
          row.storage_key,
          row.upload_id,
        );
      }
      await storageService.deleteObject(row.storage_key);
    }
    await dataSource.query('DELETE FROM "videos"');
  }

  /**
   * The video is put in `ready` directly, with its bytes uploaded to the
   * storage key, so delivery is tested without depending on the worker.
   */
  async function arrangeReadyVideo(): Promise<{
    id: string;
    slug: string;
    storageKey: string;
  }> {
    const response = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: CONTENT_LENGTH,
      })
      .expect(201);

    const { id, slug } = response.body as { id: string; slug: string };
    const repository = dataSource.getRepository(Video);
    const row = await repository.findOneByOrFail({ id });

    if (row.upload_id) {
      await storageService.abortMultipartUpload(row.storage_key, row.upload_id);
    }
    await storageService.putObject(row.storage_key, CONTENT, 'video/mp4');
    await repository.update(
      { id },
      {
        status: VideoStatus.READY,
        upload_id: null,
        uploaded_at: new Date(),
      },
    );

    return { id, slug, storageKey: row.storage_key };
  }

  function deliveryUrl(
    slug: string,
    mode: 'stream' | 'download',
    user: AuthenticatedUser = owner,
  ) {
    return request(app.getHttpServer())
      .get(`/videos/${slug}/${mode}`)
      .set('Authorization', `Bearer ${user.accessToken}`);
  }

  describe('Streaming and download of a ready video', () => {
    it('issues a stream URL that expires about four hours from now', async () => {
      const response = await deliveryUrl(video.slug, 'stream').expect(200);

      const body = response.body as DeliveryBody;
      expect(body.url).toBeTruthy();

      const expiresInMs = Date.parse(body.expiresAt) - Date.now();
      expect(expiresInMs).toBeGreaterThan(3.83 * 60 * 60 * 1000);
      expect(expiresInMs).toBeLessThan(4.17 * 60 * 60 * 1000);
    });

    it('serves partial content from the stream URL', async () => {
      const response = await deliveryUrl(video.slug, 'stream').expect(200);
      const { url } = response.body as DeliveryBody;

      // Straight to storage: the API never sees these bytes.
      const partial = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toBe(
        `bytes 0-1023/${CONTENT_LENGTH}`,
      );
      const received = Buffer.from(await partial.arrayBuffer());
      expect(received).toEqual(CONTENT.subarray(0, 1024));
    });

    it('serves the whole file as an attachment from the download URL', async () => {
      const response = await deliveryUrl(video.slug, 'download').expect(200);
      const body = response.body as DeliveryBody;
      expect(body.url).toBeTruthy();
      expect(body.expiresAt).toBeTruthy();

      const downloaded = await fetch(body.url);

      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get('content-disposition')).toBe(
        'attachment; filename="clip.mp4"',
      );
      const received = Buffer.from(await downloaded.arrayBuffer());
      expect(received).toEqual(CONTENT);
    });
  });

  describe('Rejections', () => {
    it('rejects a video that is not ready', async () => {
      await dataSource
        .getRepository(Video)
        .update({ id: video.id }, { status: VideoStatus.PROCESSING });

      for (const mode of ['stream', 'download'] as const) {
        const response = await deliveryUrl(video.slug, mode).expect(409);
        expect((response.body as { error: string }).error).toBe(
          'VIDEO_NOT_READY',
        );
      }
    });

    it('hides the video from a non-owner', async () => {
      for (const mode of ['stream', 'download'] as const) {
        const response = await deliveryUrl(video.slug, mode, otherUser).expect(
          404,
        );
        expect((response.body as { error: string }).error).toBe(
          'VIDEO_NOT_FOUND',
        );
      }
    });
  });
});
