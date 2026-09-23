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

interface InitiateUploadBody {
  id: string;
  slug: string;
  partCount: number;
  parts: { partNumber: number; url: string }[];
}

interface PartUrlsBody {
  parts: { partNumber: number; url: string }[];
  partUrlsExpireAt: string;
}

describe('POST /videos/:slug/upload/part-urls (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let owner: AuthenticatedUser;
  let otherUser: AuthenticatedUser;
  let draft: InitiateUploadBody;

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
    // Both users are created once per file: /auth is throttled to 10 req/min.
    owner = await createAuthenticatedUser(
      app,
      'part-urls-owner@streamtube.local',
    );
    otherUser = await createAuthenticatedUser(
      app,
      'part-urls-other@streamtube.local',
    );
  });

  afterAll(async () => {
    await abortOpenUploads();
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(async () => {
    await abortOpenUploads();
    draft = await initiateUpload({
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 209715200,
    });
    expect(draft.partCount).toBe(2);
  });

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

  async function initiateUpload(
    body: Record<string, unknown>,
  ): Promise<InitiateUploadBody> {
    const response = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send(body)
      .expect(201);
    return response.body as InitiateUploadBody;
  }

  function requestPartUrls(
    slug: string,
    body: Record<string, unknown>,
    user: AuthenticatedUser = owner,
  ) {
    return request(app.getHttpServer())
      .post(`/videos/${slug}/upload/part-urls`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send(body);
  }

  describe('Re-issuing part URLs', () => {
    it('re-issues a URL for the requested part', async () => {
      const before = Date.now();

      const response = await requestPartUrls(draft.slug, {
        partNumbers: [2],
      }).expect(200);

      const body = response.body as PartUrlsBody;
      expect(body.parts).toHaveLength(1);
      expect(body.parts[0].partNumber).toBe(2);
      expect(body.parts[0].url).toContain('partNumber=2');
      expect(Date.parse(body.partUrlsExpireAt)).toBeGreaterThan(before);
    });

    it('re-issues a URL that still accepts the part bytes', async () => {
      const single = await initiateUpload({
        fileName: 'small.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
      });
      expect(single.partCount).toBe(1);

      const response = await requestPartUrls(single.slug, {
        partNumbers: [1],
      }).expect(200);

      const { parts } = response.body as PartUrlsBody;
      const uploaded = await fetch(parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(1024, 3)),
      });

      expect(uploaded.status).toBe(200);
      expect(uploaded.headers.get('etag')).toBeTruthy();
    });
  });

  describe('Rejections', () => {
    it('rejects a part number beyond the part count', async () => {
      const response = await requestPartUrls(draft.slug, {
        partNumbers: [3],
      }).expect(400);

      expect((response.body as { error: string }).error).toBe(
        'VALIDATION_ERROR',
      );
    });

    it('rejects an empty part list', async () => {
      const response = await requestPartUrls(draft.slug, {
        partNumbers: [],
      }).expect(400);

      expect((response.body as { error: string }).error).toBe(
        'VALIDATION_ERROR',
      );
    });

    it('hides the video from a non-owner and from an unknown slug', async () => {
      const foreign = await requestPartUrls(
        draft.slug,
        { partNumbers: [1] },
        otherUser,
      ).expect(404);
      expect((foreign.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');

      const unknown = await requestPartUrls('AAAAAAAAAAA', {
        partNumbers: [1],
      }).expect(404);
      expect((unknown.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    });

    it('rejects the request once the upload is no longer open', async () => {
      await dataSource
        .getRepository(Video)
        .update({ slug: draft.slug }, { status: VideoStatus.PROCESSING });

      const response = await requestPartUrls(draft.slug, {
        partNumbers: [1],
      }).expect(409);

      expect((response.body as { error: string }).error).toBe(
        'VIDEO_NOT_IN_DRAFT',
      );
    });
  });
});
