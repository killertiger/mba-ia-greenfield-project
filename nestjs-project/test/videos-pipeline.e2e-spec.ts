/**
 * End-to-end proof of the whole video pipeline against the real Compose
 * infrastructure: the bytes go straight to MinIO through presigned URLs, the
 * `video-worker` container picks the job from Redis and processes it, and the
 * ready video is served back through presigned stream/download URLs.
 *
 * REQUIRES the worker to be running: `docker compose up -d` (service
 * `video-worker`). Nothing here calls the processing service directly.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFile, stat } from 'node:fs/promises';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { StorageService } from '../src/storage/storage.service';
import { Video } from '../src/videos/entities/video.entity';
import {
  createSampleVideo,
  removeSampleVideo,
  SampleVideo,
} from './fixtures/sample-video';
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

interface VideoBody {
  status: string;
  sizeBytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  metadata: Record<string, unknown> | null;
  thumbnailUrl: string | null;
  processingError: string | null;
}

interface DeliveryBody {
  url: string;
  expiresAt: string;
}

const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1000;

describe('Video pipeline (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let user: AuthenticatedUser;
  let sample: SampleVideo;

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
    user = await createAuthenticatedUser(app, 'pipeline@streamtube.local');
    sample = await createSampleVideo();
  }, 90_000);

  afterAll(async () => {
    for (const video of await dataSource.getRepository(Video).find()) {
      await storageService.deleteObject(video.storage_key);
      if (video.thumbnail_key) {
        await storageService.deleteObject(video.thumbnail_key);
      }
    }
    await cleanAllTables(dataSource);
    await removeSampleVideo(sample);
    await app.close();
  });

  function authed(method: 'get' | 'post', path: string) {
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${user.accessToken}`);
  }

  async function waitForReady(slug: string): Promise<VideoBody> {
    const deadline = Date.now() + READY_TIMEOUT_MS;

    for (;;) {
      const response = await authed('get', `/videos/${slug}`).expect(200);
      const body = response.body as VideoBody;

      if (body.status === 'ready') return body;
      if (body.status === 'error') {
        throw new Error(`Processing failed: ${body.processingError}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Video ${slug} is still "${body.status}" after ${READY_TIMEOUT_MS}ms. Is the video-worker container running?`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  it('takes a video from upload to playback through the real worker', async () => {
    const bytes = await readFile(sample.path);
    const { size } = await stat(sample.path);

    // 1. Pre-register the video and open the multipart upload.
    const initiated = await authed('post', '/videos')
      .send({
        fileName: 'pipeline.mp4',
        mimeType: 'video/mp4',
        sizeBytes: size,
      })
      .expect(201);
    const draft = initiated.body as InitiateUploadBody;

    // 2. Send every part straight to storage — the API never sees the bytes.
    const partSize = Math.ceil(bytes.length / draft.partCount);
    const parts = await Promise.all(
      draft.parts.map(async ({ partNumber, url }) => {
        const start = (partNumber - 1) * partSize;
        const chunk = bytes.subarray(start, start + partSize);
        const uploaded = await fetch(url, {
          method: 'PUT',
          body: new Uint8Array(chunk),
        });
        expect(uploaded.status).toBe(200);
        return { partNumber, etag: uploaded.headers.get('etag')! };
      }),
    );

    // 3. Complete the upload; the API enqueues the processing job.
    const completed = await authed(
      'post',
      `/videos/${draft.slug}/upload/complete`,
    )
      .send({ parts })
      .expect(202);
    expect((completed.body as { status: string }).status).toBe('processing');

    // 4. The video-worker container processes the job on its own.
    const ready = await waitForReady(draft.slug);

    expect(ready.sizeBytes).toBe(size);
    expect(ready.durationSeconds).toBeCloseTo(sample.durationSeconds, 1);
    expect(ready.width).toBe(sample.width);
    expect(ready.height).toBe(sample.height);
    expect(ready.metadata).toMatchObject({ videoCodec: 'h264' });
    expect(ready.processingError).toBeNull();

    const thumbnail = await fetch(ready.thumbnailUrl!);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');

    // 5. Playback: storage answers the Range request with partial content.
    const stream = await authed('get', `/videos/${draft.slug}/stream`).expect(
      200,
    );
    const partial = await fetch((stream.body as DeliveryBody).url, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 0-1023/${size}`);
    expect((await partial.arrayBuffer()).byteLength).toBe(1024);

    // 6. Download: the whole file, as an attachment.
    const download = await authed(
      'get',
      `/videos/${draft.slug}/download`,
    ).expect(200);
    const downloaded = await fetch((download.body as DeliveryBody).url);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-disposition')).toBe(
      'attachment; filename="pipeline.mp4"',
    );
    const received = Buffer.from(await downloaded.arrayBuffer());
    expect(received.length).toBe(size);
    expect(received).toEqual(bytes);
  }, 90_000);
});
