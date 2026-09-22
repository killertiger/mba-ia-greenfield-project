import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SampleVideo {
  path: string;
  directory: string;
  durationSeconds: number;
  width: number;
  height: number;
}

const DEFAULTS = {
  durationSeconds: 2,
  width: 320,
  height: 240,
  frameRate: 25,
} as const;

/**
 * Generates a short MP4 (video + audio) with ffmpeg's synthetic sources, so no
 * binary media file has to live in the repository.
 */
export async function createSampleVideo(
  fileName = 'sample.mp4',
): Promise<SampleVideo> {
  const directory = await mkdtemp(join(tmpdir(), 'streamtube-fixture-'));
  const path = join(directory, fileName);
  const { durationSeconds, width, height, frameRate } = DEFAULTS;

  await runFfmpeg([
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=${frameRate}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${durationSeconds}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-y',
    path,
  ]);

  return { path, directory, durationSeconds, width, height };
}

export async function removeSampleVideo(video: SampleVideo): Promise<void> {
  await rm(video.directory, { recursive: true, force: true });
}

async function runFfmpeg(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { shell: false, timeout: 60000 });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`ffmpeg fixture generation failed (${code}): ${stderr}`),
      );
    });
  });
}
