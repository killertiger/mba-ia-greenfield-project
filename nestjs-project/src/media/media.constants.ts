export const MEDIA_BINARIES = {
  FFPROBE: 'ffprobe',
  FFMPEG: 'ffmpeg',
} as const;

export const FFPROBE_ARGS = [
  '-v',
  'error',
  '-print_format',
  'json',
  '-show_format',
  '-show_streams',
] as const;

export const MEDIA_TIMEOUTS = {
  PROBE_MS: 30000,
  EXTRACT_FRAME_MS: 60000,
} as const;

/** How much of stderr is kept in the rejection message. */
export const MEDIA_STDERR_TAIL_CHARS = 2000;
