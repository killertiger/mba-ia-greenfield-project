export const VIDEO_SLUG = {
  ALPHABET: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  LENGTH: 11,
  PATTERN: /^[0-9A-Za-z]{11}$/,
} as const;

export const VIDEO_UPLOAD = {
  MAX_SIZE_BYTES: 10737418240, // 10 GiB
  PART_SIZE_BYTES: 104857600, // 100 MiB
  MAX_PARTS: 10000,
  SLUG_MAX_ATTEMPTS: 3,
} as const;

export const ALLOWED_VIDEO_MIME_TYPES = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
} as const;

export type AllowedVideoMimeType = keyof typeof ALLOWED_VIDEO_MIME_TYPES;

export const VIDEO_DELIVERY_MODES = {
  STREAM: 'stream',
  DOWNLOAD: 'download',
} as const;

export type VideoDeliveryMode =
  (typeof VIDEO_DELIVERY_MODES)[keyof typeof VIDEO_DELIVERY_MODES];
