import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import { MultipartCompletionError } from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIN_NON_LAST_PART_BYTES = 5 * 1024 * 1024;

async function putPart(url: string, body: Buffer): Promise<string> {
  const response = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
  });
  expect(response.status).toBe(200);
  const etag = response.headers.get('etag');
  expect(etag).toBeTruthy();
  return etag!;
}

describe('StorageService (integration)', () => {
  const prefix = `test/storage-${randomUUID()}`;
  const createdKeys: string[] = [];
  let module: TestingModule;
  let storage: StorageService;

  const newKey = (name: string): string => {
    const key = `${prefix}/${name}`;
    createdKeys.push(key);
    return key;
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await Promise.all(createdKeys.map((key) => storage.deleteObject(key)));
    await module.close();
  });

  describe('multipart upload through presigned part URLs', () => {
    it('should complete a two-part upload whose size is the sum of the parts', async () => {
      const key = newKey('two-parts.mp4');
      const part1 = randomBytes(MIN_NON_LAST_PART_BYTES);
      const part2 = randomBytes(1024);
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      const etag1 = await putPart(
        await storage.presignUploadPart(key, uploadId, 1),
        part1,
      );
      const etag2 = await putPart(
        await storage.presignUploadPart(key, uploadId, 2),
        part2,
      );
      await storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: etag1 },
        { partNumber: 2, etag: etag2 },
      ]);

      await expect(storage.headObject(key)).resolves.toEqual({
        contentLength: part1.length + part2.length,
      });
    });

    it('should reject a wrong ETag with MultipartCompletionError and keep the upload open', async () => {
      const key = newKey('wrong-etag.mp4');
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const etag = await putPart(
        await storage.presignUploadPart(key, uploadId, 1),
        randomBytes(1024),
      );

      await expect(
        storage.completeMultipartUpload(key, uploadId, [
          { partNumber: 1, etag: '"00000000000000000000000000000000"' },
        ]),
      ).rejects.toBeInstanceOf(MultipartCompletionError);

      await storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag },
      ]);
      await expect(storage.headObject(key)).resolves.toEqual({
        contentLength: 1024,
      });
    });

    it('should make a completion fail after the upload is aborted', async () => {
      const key = newKey('aborted.mp4');
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const etag = await putPart(
        await storage.presignUploadPart(key, uploadId, 1),
        randomBytes(1024),
      );

      await storage.abortMultipartUpload(key, uploadId);

      await expect(
        storage.completeMultipartUpload(key, uploadId, [
          { partNumber: 1, etag },
        ]),
      ).rejects.toBeInstanceOf(MultipartCompletionError);
      await expect(storage.headObject(key)).resolves.toBeNull();
    });
  });

  describe('presigned GET', () => {
    const content = randomBytes(4096);
    let key: string;

    beforeAll(async () => {
      key = newKey('object.mp4');
      await storage.putObject(key, content, 'video/mp4');
    });

    it('should serve a Range request with 206 Partial Content', async () => {
      const url = await storage.presignGetObject(key, { audience: 'public' });

      const response = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
      });
      const body = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 0-1023/4096');
      expect(body.equals(content.subarray(0, 1024))).toBe(true);
    });

    it('should return the requested Content-Disposition', async () => {
      const url = await storage.presignGetObject(key, {
        audience: 'public',
        disposition: 'attachment; filename="clip.mp4"',
      });

      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="clip.mp4"',
      );
      expect(Buffer.from(await response.arrayBuffer()).length).toBe(4096);
    });
  });

  describe('delete and head', () => {
    it('should report a deleted object as missing', async () => {
      const key = newKey('deleted.mp4');
      await storage.putObject(key, randomBytes(16), 'video/mp4');

      await storage.deleteObject(key);

      await expect(storage.headObject(key)).resolves.toBeNull();
    });
  });

  describe('URL audience', () => {
    it('should sign public URLs for S3_PUBLIC_ENDPOINT and internal URLs for S3_ENDPOINT', async () => {
      const config = storageConfig();
      const audienceModule = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
          StorageModule,
        ],
      })
        .overrideProvider(storageConfig.KEY)
        .useValue({
          ...config,
          publicEndpoint: 'http://storage.public.test:9000',
        })
        .compile();
      const service = audienceModule.get(StorageService);

      const publicUrl = await service.presignGetObject('any.mp4', {
        audience: 'public',
      });
      const internalUrl = await service.presignGetObject('any.mp4', {
        audience: 'internal',
      });

      expect(new URL(publicUrl).host).toBe('storage.public.test:9000');
      expect(new URL(internalUrl).host).toBe(new URL(config.endpoint).host);
      await audienceModule.close();
    });
  });
});
