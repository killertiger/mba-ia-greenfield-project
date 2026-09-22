import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import {
  FFPROBE_ARGS,
  MEDIA_BINARIES,
  MEDIA_STDERR_TAIL_CHARS,
  MEDIA_TIMEOUTS,
} from './media.constants';
import { MediaCommandError } from './media.errors';

export interface ProbeResult {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  formatName: string | null;
  hasVideoStream: boolean;
  metadata: Record<string, unknown>;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
  r_frame_rate?: string;
}

interface FfprobeOutput {
  format?: {
    duration?: string;
    format_name?: string;
    bit_rate?: string;
  };
  streams?: FfprobeStream[];
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Maps the raw ffprobe JSON onto the columns of `videos` — pure, so the
 * mapping is testable without running a binary.
 */
export function parseProbeOutput(json: unknown): ProbeResult {
  const output = (json ?? {}) as FfprobeOutput;
  const streams = output.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  return {
    durationSeconds: toNumber(output.format?.duration),
    width: video?.width ?? null,
    height: video?.height ?? null,
    formatName: output.format?.format_name ?? null,
    hasVideoStream: video !== undefined,
    metadata: {
      formatName: output.format?.format_name ?? null,
      bitRate: toNumber(output.format?.bit_rate),
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      frameRate: video?.r_frame_rate ?? null,
    },
  };
}

@Injectable()
export class MediaProbeService {
  /** `input` is a local path or an HTTP(S) URL — ffprobe reads both. */
  async probe(input: string): Promise<ProbeResult> {
    const stdout = await this.run(
      MEDIA_BINARIES.FFPROBE,
      [...FFPROBE_ARGS, input],
      MEDIA_TIMEOUTS.PROBE_MS,
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new MediaCommandError(
        MEDIA_BINARIES.FFPROBE,
        0,
        `unreadable JSON output: ${stdout.slice(0, MEDIA_STDERR_TAIL_CHARS)}`,
      );
    }
    return parseProbeOutput(parsed);
  }

  async extractFrame(
    input: string,
    atSeconds: number,
    outputPath: string,
  ): Promise<void> {
    await this.run(
      MEDIA_BINARIES.FFMPEG,
      [
        '-v',
        'error',
        // Seeking before -i is the fast path: ffmpeg jumps straight to the
        // keyframe instead of decoding everything up to it.
        '-ss',
        String(atSeconds),
        '-i',
        input,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '-y',
        outputPath,
      ],
      MEDIA_TIMEOUTS.EXTRACT_FRAME_MS,
    );
  }

  /**
   * Arguments are passed as an array and never through a shell, so a path
   * containing spaces or `;` stays a single argument.
   */
  private async run(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, { shell: false, timeout: timeoutMs });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        reject(new MediaCommandError(command, null, error.message));
      });

      child.on('close', (code, signal) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        const tail = stderr.slice(-MEDIA_STDERR_TAIL_CHARS).trim();
        reject(
          new MediaCommandError(
            command,
            code,
            signal === null ? tail : `killed with ${signal}. ${tail}`,
          ),
        );
      });
    });
  }
}
