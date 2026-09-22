export const THUMBNAIL = {
  FILE_NAME: 'thumbnail.jpg',
  CONTENT_TYPE: 'image/jpeg',
  /** Frame taken at 10% of the duration — past intros, still early. */
  POSITION_RATIO: 0.1,
} as const;

/**
 * ffprobe reports containers as a comma-separated list (`mov,mp4,m4a,...`),
 * so the allowlist is matched as a substring of `format_name`.
 */
export const ALLOWED_CONTAINER_TOKENS = ['mp4', 'webm'] as const;

export const PROCESSING_ERROR_PREFIXES = {
  UNSUPPORTED_MEDIA: 'UNSUPPORTED_MEDIA',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
  UPLOAD_ABANDONED: 'UPLOAD_ABANDONED',
} as const;

export const ABANDONED_UPLOAD = {
  /** A draft older than this with an open upload is considered abandoned. */
  MAX_AGE_MS: 24 * 60 * 60 * 1000,
  SWEEP_INTERVAL_MS: 60 * 60 * 1000,
} as const;
