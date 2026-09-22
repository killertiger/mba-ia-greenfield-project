export const STORAGE_CLIENTS = {
  INTERNAL: Symbol('S3_INTERNAL_CLIENT'),
  PUBLIC: Symbol('S3_PUBLIC_CLIENT'),
} as const;

export const MULTIPART_COMPLETION_ERROR_NAMES = [
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'NoSuchUpload',
] as const;
