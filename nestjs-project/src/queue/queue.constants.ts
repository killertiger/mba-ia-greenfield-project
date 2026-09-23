export const QUEUE_NAMES = {
  VIDEO_PROCESSING: 'video-processing',
  VIDEO_MAINTENANCE: 'video-maintenance',
} as const;

export const JOB_NAMES = {
  PROCESS_VIDEO: 'process-video',
  SWEEP_ABANDONED_UPLOADS: 'sweep-abandoned-uploads',
} as const;

export const SCHEDULER_IDS = {
  ABANDONED_UPLOAD_SWEEP: 'abandoned-upload-sweep',
} as const;

export const PROCESS_VIDEO_JOB_OPTIONS = {
  ATTEMPTS: 3,
  BACKOFF_DELAY_MS: 5000,
} as const;
