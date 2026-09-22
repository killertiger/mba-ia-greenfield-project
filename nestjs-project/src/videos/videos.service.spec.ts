import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { MultipartCompletionError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingQueue } from './video-processing.queue';
import { VideosService } from './videos.service';
import { VIDEO_UPLOAD } from './videos.constants';
import {
  InvalidPartNumbersException,
  UploadPartsInvalidException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotInDraftException,
  VideoNotReadyException,
} from './videos.exceptions';

const CHANNEL_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

function slugUniqueViolation(): QueryFailedError {
  const error = new QueryFailedError('INSERT', [], new Error('duplicate'));
  Object.assign(error, {
    code: '23505',
    detail: 'Key (slug)=(abcdefghijk) already exists.',
  });
  return error;
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let videoProcessingQueue: { enqueueProcessVideo: jest.Mock };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    abortMultipartUpload: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
    deleteObject: jest.Mock;
    presignGetObject: jest.Mock;
    uploadPartUrlTtlSeconds: number;
    downloadUrlTtlSeconds: number;
  };

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((entity: Partial<Video>) => entity as Video),
      save: jest.fn((entity: Video) => Promise.resolve(entity)),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    videoProcessingQueue = {
      enqueueProcessVideo: jest.fn().mockResolvedValue(undefined),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: CHANNEL_ID }),
    };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      presignUploadPart: jest
        .fn()
        .mockImplementation((_key: string, _id: string, part: number) =>
          Promise.resolve(`https://storage.local/part/${part}`),
        ),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn(),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      presignGetObject: jest
        .fn()
        .mockResolvedValue('https://storage.local/thumbnail'),
      uploadPartUrlTtlSeconds: 3600,
      downloadUrlTtlSeconds: 14400,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: VideoProcessingQueue, useValue: videoProcessingQueue },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  const SLUG = 'V1StGXR8Z5j';
  const VIDEO_ID = '33333333-3333-3333-3333-333333333333';

  function draft(overrides: Partial<Video> = {}): Video {
    return {
      id: VIDEO_ID,
      slug: SLUG,
      channel_id: CHANNEL_ID,
      status: VideoStatus.DRAFT,
      storage_key: 'videos/33333333/original.mp4',
      upload_id: 'upload-1',
      part_count: 2,
      size_bytes: '2048',
      original_file_name: 'clip.mp4',
      duration_seconds: null,
      width: null,
      height: null,
      metadata: null,
      thumbnail_key: null,
      processing_error: null,
      created_at: new Date('2026-09-01T10:00:00.000Z'),
      updated_at: new Date('2026-09-01T10:00:00.000Z'),
      ...overrides,
    } as Video;
  }

  const dto = {
    fileName: 'my.holiday.clip.mp4',
    mimeType: 'video/mp4' as const,
    sizeBytes: 209715200,
  };

  it('derives the title from the file name when none is given', async () => {
    const result = await service.initiateUpload(USER_ID, dto);

    expect(result.title).toBe('my.holiday.clip');
  });

  it('keeps the given title', async () => {
    const result = await service.initiateUpload(USER_ID, {
      ...dto,
      title: 'My holiday',
    });

    expect(result.title).toBe('My holiday');
  });

  it('splits the declared size into parts of the configured size', async () => {
    const result = await service.initiateUpload(USER_ID, {
      ...dto,
      sizeBytes: VIDEO_UPLOAD.PART_SIZE_BYTES * 2 + 1,
    });

    expect(result.partCount).toBe(3);
    expect(result.partSizeBytes).toBe(VIDEO_UPLOAD.PART_SIZE_BYTES);
    expect(result.parts.map((part) => part.partNumber)).toEqual([1, 2, 3]);
    expect(storageService.presignUploadPart).toHaveBeenCalledTimes(3);
  });

  it('retries with a new slug when the generated one collides', async () => {
    videoRepository.save
      .mockRejectedValueOnce(slugUniqueViolation())
      .mockImplementationOnce((entity: Video) => Promise.resolve(entity));

    const result = await service.initiateUpload(USER_ID, dto);

    expect(videoRepository.save).toHaveBeenCalledTimes(2);
    const [first, second] = videoRepository.save.mock.calls.map(
      ([entity]: [Video]) => entity.slug,
    );
    expect(first).not.toBe(second);
    expect(result.slug).toBe(second);
    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it('gives up after the configured number of slug attempts', async () => {
    videoRepository.save.mockRejectedValue(slugUniqueViolation());

    await expect(service.initiateUpload(USER_ID, dto)).rejects.toThrow(
      QueryFailedError,
    );
    expect(videoRepository.save).toHaveBeenCalledTimes(
      VIDEO_UPLOAD.SLUG_MAX_ATTEMPTS,
    );
  });

  it('aborts the multipart upload when persisting the draft fails', async () => {
    videoRepository.save.mockRejectedValue(new Error('db is down'));

    await expect(service.initiateUpload(USER_ID, dto)).rejects.toThrow(
      'db is down',
    );
    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      expect.stringMatching(/^videos\/.+\/original\.mp4$/),
      'upload-1',
    );
    expect(storageService.presignUploadPart).not.toHaveBeenCalled();
  });

  describe('reissuePartUrls', () => {
    it('re-issues a URL only for the requested parts', async () => {
      videoRepository.findOne.mockResolvedValue(draft());

      const result = await service.reissuePartUrls(USER_ID, SLUG, {
        partNumbers: [2],
      });

      expect(result.parts).toEqual([
        { partNumber: 2, url: 'https://storage.local/part/2' },
      ]);
      expect(Date.parse(result.partUrlsExpireAt)).toBeGreaterThan(Date.now());
      expect(storageService.presignUploadPart).toHaveBeenCalledTimes(1);
      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        'videos/33333333/original.mp4',
        'upload-1',
        2,
      );
    });

    it('hides a video of another channel behind a 404', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.reissuePartUrls(USER_ID, SLUG, { partNumbers: [1] }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { slug: SLUG, channel_id: CHANNEL_ID },
      });
    });

    it('rejects a malformed slug without touching the database', async () => {
      await expect(
        service.reissuePartUrls(USER_ID, 'not-a-slug', { partNumbers: [1] }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(videoRepository.findOne).not.toHaveBeenCalled();
    });

    it('rejects a video that is no longer a draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        draft({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.reissuePartUrls(USER_ID, SLUG, { partNumbers: [1] }),
      ).rejects.toBeInstanceOf(VideoNotInDraftException);
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });

    it('rejects a draft whose multipart upload is already closed', async () => {
      videoRepository.findOne.mockResolvedValue(draft({ upload_id: null }));

      await expect(
        service.reissuePartUrls(USER_ID, SLUG, { partNumbers: [1] }),
      ).rejects.toBeInstanceOf(VideoNotInDraftException);
    });

    it('rejects a part number beyond the video part count', async () => {
      videoRepository.findOne.mockResolvedValue(draft());

      await expect(
        service.reissuePartUrls(USER_ID, SLUG, { partNumbers: [1, 3] }),
      ).rejects.toBeInstanceOf(InvalidPartNumbersException);
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });
  });

  describe('getOwnedVideo', () => {
    it('converts bigint and numeric columns to JSON numbers', async () => {
      videoRepository.findOne.mockResolvedValue(
        draft({
          status: VideoStatus.READY,
          size_bytes: '10737418240',
          duration_seconds: '2.500',
          width: 320,
          height: 240,
          metadata: { videoCodec: 'h264' },
          created_at: new Date('2026-09-01T10:00:00.000Z'),
          updated_at: new Date('2026-09-01T10:05:00.000Z'),
        }),
      );

      const result = await service.getOwnedVideo(USER_ID, SLUG);

      expect(result.sizeBytes).toBe(10737418240);
      expect(result.durationSeconds).toBe(2.5);
      expect(result.width).toBe(320);
      expect(result.metadata).toEqual({ videoCodec: 'h264' });
      expect(result.createdAt).toBe('2026-09-01T10:00:00.000Z');
      expect(result.updatedAt).toBe('2026-09-01T10:05:00.000Z');
    });

    it('returns no thumbnail URL while the thumbnail does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(draft());

      const result = await service.getOwnedVideo(USER_ID, SLUG);

      expect(result.thumbnailUrl).toBeNull();
      expect(result.durationSeconds).toBeNull();
      expect(storageService.presignGetObject).not.toHaveBeenCalled();
    });

    it('presigns the thumbnail for the public audience', async () => {
      videoRepository.findOne.mockResolvedValue(
        draft({ thumbnail_key: 'videos/33333333/thumbnail.jpg' }),
      );

      const result = await service.getOwnedVideo(USER_ID, SLUG);

      expect(result.thumbnailUrl).toBe('https://storage.local/thumbnail');
      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos/33333333/thumbnail.jpg',
        { audience: 'public' },
      );
    });

    it('hides a video of another channel behind a 404', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(service.getOwnedVideo(USER_ID, SLUG)).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });
  });

  describe('getDeliveryUrl', () => {
    const ready = (overrides: Partial<Video> = {}) =>
      draft({
        status: VideoStatus.READY,
        upload_id: null,
        original_file_name: 'clip.mp4',
        ...overrides,
      });

    it('signs a plain URL for streaming', async () => {
      videoRepository.findOne.mockResolvedValue(ready());

      const result = await service.getDeliveryUrl(USER_ID, SLUG, 'stream');

      expect(result.url).toBe('https://storage.local/thumbnail');
      expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos/33333333/original.mp4',
        { audience: 'public' },
      );
    });

    it('forces an attachment for download', async () => {
      videoRepository.findOne.mockResolvedValue(ready());

      await service.getDeliveryUrl(USER_ID, SLUG, 'download');

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos/33333333/original.mp4',
        {
          audience: 'public',
          disposition: 'attachment; filename="clip.mp4"',
        },
      );
    });

    it('escapes quotes and control characters in the file name', async () => {
      videoRepository.findOne.mockResolvedValue(
        ready({ original_file_name: 'my "best"\r\n clip.mp4' }),
      );

      await service.getDeliveryUrl(USER_ID, SLUG, 'download');

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos/33333333/original.mp4',
        {
          audience: 'public',
          disposition: 'attachment; filename="my \\"best\\" clip.mp4"',
        },
      );
    });

    it('rejects a video that is not ready', async () => {
      videoRepository.findOne.mockResolvedValue(
        draft({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.getDeliveryUrl(USER_ID, SLUG, 'stream'),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
      expect(storageService.presignGetObject).not.toHaveBeenCalled();
    });

    it('hides a video of another channel behind a 404', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getDeliveryUrl(USER_ID, SLUG, 'download'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('completeUpload', () => {
    const allParts = {
      parts: [
        { partNumber: 1, etag: '"aaa"' },
        { partNumber: 2, etag: '"bbb"' },
      ],
    };

    beforeEach(() => {
      videoRepository.findOne.mockResolvedValue(draft());
      storageService.headObject.mockResolvedValue({ contentLength: 2048 });
    });

    it('completes the upload, moves the video to processing and enqueues the job', async () => {
      const result = await service.completeUpload(USER_ID, SLUG, allParts);

      expect(result).toEqual({
        id: VIDEO_ID,
        slug: SLUG,
        status: VideoStatus.PROCESSING,
      });
      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/33333333/original.mp4',
        'upload-1',
        [
          { partNumber: 1, etag: '"aaa"' },
          { partNumber: 2, etag: '"bbb"' },
        ],
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        expect.objectContaining({
          status: VideoStatus.PROCESSING,
          upload_id: null,
          uploaded_at: expect.any(Date) as Date,
        }),
      );
      expect(videoProcessingQueue.enqueueProcessVideo).toHaveBeenCalledWith(
        VIDEO_ID,
      );
    });

    it('rejects a video that is no longer a draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        draft({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.completeUpload(USER_ID, SLUG, allParts),
      ).rejects.toBeInstanceOf(VideoNotInDraftException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('rejects a part set that does not cover the whole upload', async () => {
      await expect(
        service.completeUpload(USER_ID, SLUG, {
          parts: [{ partNumber: 1, etag: '"aaa"' }],
        }),
      ).rejects.toBeInstanceOf(InvalidPartNumbersException);

      await expect(
        service.completeUpload(USER_ID, SLUG, {
          parts: [
            { partNumber: 1, etag: '"aaa"' },
            { partNumber: 3, etag: '"ccc"' },
          ],
        }),
      ).rejects.toBeInstanceOf(InvalidPartNumbersException);

      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('keeps the video as a draft when storage rejects the parts', async () => {
      storageService.completeMultipartUpload.mockRejectedValue(
        new MultipartCompletionError('InvalidPart', 'one or more parts'),
      );

      await expect(
        service.completeUpload(USER_ID, SLUG, allParts),
      ).rejects.toBeInstanceOf(UploadPartsInvalidException);
      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(videoProcessingQueue.enqueueProcessVideo).not.toHaveBeenCalled();
    });

    it('discards the object and marks the video as error on a size mismatch', async () => {
      storageService.headObject.mockResolvedValue({ contentLength: 1024 });

      await expect(
        service.completeUpload(USER_ID, SLUG, allParts),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);

      expect(storageService.deleteObject).toHaveBeenCalledWith(
        'videos/33333333/original.mp4',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        {
          status: VideoStatus.ERROR,
          upload_id: null,
          processing_error:
            'UPLOAD_SIZE_MISMATCH: declared 2048 bytes, stored 1024 bytes',
        },
      );
      expect(videoProcessingQueue.enqueueProcessVideo).not.toHaveBeenCalled();
    });

    it('rolls the video back to draft when the job cannot be enqueued', async () => {
      videoProcessingQueue.enqueueProcessVideo.mockRejectedValue(
        new Error('redis is down'),
      );

      await expect(
        service.completeUpload(USER_ID, SLUG, allParts),
      ).rejects.toThrow('redis is down');

      expect(videoRepository.update).toHaveBeenLastCalledWith(
        { id: VIDEO_ID },
        {
          status: VideoStatus.DRAFT,
          uploaded_at: null,
          upload_id: 'upload-1',
        },
      );
    });
  });
});
