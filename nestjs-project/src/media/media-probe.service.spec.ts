import { parseProbeOutput } from './media-probe.service';

const videoStream = {
  codec_type: 'video',
  codec_name: 'h264',
  width: 320,
  height: 240,
  r_frame_rate: '25/1',
};

const audioStream = {
  codec_type: 'audio',
  codec_name: 'aac',
};

describe('parseProbeOutput', () => {
  it('maps format and the first video stream', () => {
    const result = parseProbeOutput({
      format: {
        duration: '2.048000',
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        bit_rate: '128000',
      },
      streams: [videoStream, audioStream],
    });

    expect(result).toEqual({
      durationSeconds: 2.048,
      width: 320,
      height: 240,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      hasVideoStream: true,
      metadata: {
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
        bitRate: 128000,
        videoCodec: 'h264',
        audioCodec: 'aac',
        frameRate: '25/1',
      },
    });
  });

  it('ignores streams that come before the first video one', () => {
    const result = parseProbeOutput({
      streams: [
        audioStream,
        videoStream,
        { codec_type: 'video', codec_name: 'vp9', width: 1920, height: 1080 },
      ],
    });

    expect(result.width).toBe(320);
    expect(result.height).toBe(240);
    expect(result.metadata.videoCodec).toBe('h264');
  });

  it('reports a file without a video stream', () => {
    const result = parseProbeOutput({
      format: { duration: '5.0', format_name: 'mp3' },
      streams: [audioStream],
    });

    expect(result.hasVideoStream).toBe(false);
    expect(result.width).toBeNull();
    expect(result.height).toBeNull();
    expect(result.metadata.audioCodec).toBe('aac');
    expect(result.metadata.videoCodec).toBeNull();
  });

  it('leaves every field null when ffprobe reports nothing', () => {
    const result = parseProbeOutput({});

    expect(result).toEqual({
      durationSeconds: null,
      width: null,
      height: null,
      formatName: null,
      hasVideoStream: false,
      metadata: {
        formatName: null,
        bitRate: null,
        videoCodec: null,
        audioCodec: null,
        frameRate: null,
      },
    });
  });

  it('treats an unparseable duration as absent', () => {
    const result = parseProbeOutput({
      format: { duration: 'N/A' },
      streams: [videoStream],
    });

    expect(result.durationSeconds).toBeNull();
  });
});
