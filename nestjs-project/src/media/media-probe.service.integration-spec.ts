import { Test } from '@nestjs/testing';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createSampleVideo,
  removeSampleVideo,
  SampleVideo,
} from '../../test/fixtures/sample-video';
import { MediaProbeService } from './media-probe.service';
import { MediaModule } from './media.module';
import { MediaCommandError } from './media.errors';

describe('MediaProbeService (integration)', () => {
  let service: MediaProbeService;
  let sample: SampleVideo;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [MediaModule],
    }).compile();
    service = module.get(MediaProbeService);

    sample = await createSampleVideo();
  }, 60000);

  afterAll(async () => {
    await removeSampleVideo(sample);
  });

  it('reads duration, dimensions and codecs from a real file', async () => {
    const result = await service.probe(sample.path);

    expect(result.durationSeconds).toBeCloseTo(sample.durationSeconds, 1);
    expect(result.width).toBe(sample.width);
    expect(result.height).toBe(sample.height);
    expect(result.hasVideoStream).toBe(true);
    expect(result.formatName).toContain('mp4');
    expect(result.metadata.videoCodec).toBe('h264');
    expect(result.metadata.audioCodec).toBe('aac');
  });

  it('rejects a file that is not media, carrying the ffprobe output', async () => {
    const textFile = join(sample.directory, 'not-a-video.mp4');
    await writeFile(textFile, 'this is plain text, not a video');

    await expect(service.probe(textFile)).rejects.toBeInstanceOf(
      MediaCommandError,
    );
    await expect(service.probe(textFile)).rejects.toThrow(/ffprobe failed/);
  });

  it('extracts a non-empty JPEG frame', async () => {
    const output = join(sample.directory, 'frame.jpg');

    await service.extractFrame(sample.path, 1, output);

    const { size } = await stat(output);
    expect(size).toBeGreaterThan(0);
  });

  it('treats a path with shell metacharacters as a single argument', async () => {
    // If the arguments went through a shell, `;` would split the command and
    // `rm` would run; spawn without a shell keeps it part of the file name.
    const tricky = await createSampleVideo('a video; rm -rf .mp4');
    try {
      const result = await service.probe(tricky.path);
      expect(result.hasVideoStream).toBe(true);
      await expect(stat(tricky.path)).resolves.toBeDefined();
    } finally {
      await removeSampleVideo(tricky);
    }
  }, 60000);
});
