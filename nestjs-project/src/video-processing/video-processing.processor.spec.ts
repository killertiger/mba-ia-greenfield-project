import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

const VIDEO_ID = '44444444-4444-4444-4444-444444444444';

function failedJob(
  attemptsMade: number,
  attempts = 3,
): Job<{
  videoId: string;
}> {
  return {
    id: VIDEO_ID,
    data: { videoId: VIDEO_ID },
    attemptsMade,
    opts: { attempts },
  } as Job<{ videoId: string }>;
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let videoRepository: { update: jest.Mock };
  let videoProcessingService: { process: jest.Mock };

  beforeEach(async () => {
    videoRepository = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    videoProcessingService = {
      process: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        {
          provide: VideoProcessingService,
          useValue: videoProcessingService,
        },
        { provide: getRepositoryToken(Video), useValue: videoRepository },
      ],
    }).compile();

    processor = module.get(VideoProcessingProcessor);
  });

  it('delegates the job to the processing service', async () => {
    await processor.process(failedJob(0));

    expect(videoProcessingService.process).toHaveBeenCalledWith(VIDEO_ID);
  });

  it('leaves the video alone while retries remain', async () => {
    await processor.onFailed(failedJob(1), new Error('storage timeout'));
    await processor.onFailed(failedJob(2), new Error('storage timeout'));

    expect(videoRepository.update).not.toHaveBeenCalled();
  });

  it('records PROCESSING_FAILED on the last attempt', async () => {
    await processor.onFailed(failedJob(3), new Error('storage timeout'));

    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: VIDEO_ID },
      {
        status: VideoStatus.ERROR,
        processing_error: 'PROCESSING_FAILED: storage timeout',
      },
    );
  });

  it('records UNSUPPORTED_MEDIA on the first unrecoverable failure', async () => {
    await processor.onFailed(
      failedJob(1),
      new UnrecoverableError('UNSUPPORTED_MEDIA: no video stream found'),
    );

    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: VIDEO_ID },
      {
        status: VideoStatus.ERROR,
        processing_error: 'UNSUPPORTED_MEDIA: no video stream found',
      },
    );
  });

  it('does not throw when the failure cannot be recorded', async () => {
    videoRepository.update.mockRejectedValue(new Error('db is down'));

    await expect(
      processor.onFailed(failedJob(3), new Error('storage timeout')),
    ).resolves.toBeUndefined();
  });
});
