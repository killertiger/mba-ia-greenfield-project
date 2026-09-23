import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY!,
  secretKey: process.env.S3_SECRET_KEY!,
  bucket: process.env.S3_BUCKET || 'streamtube',
  uploadPartUrlExpiresSeconds: parseInt(
    process.env.S3_UPLOAD_PART_URL_EXPIRES_SECONDS || '3600',
    10,
  ),
  downloadUrlExpiresSeconds: parseInt(
    process.env.S3_DOWNLOAD_URL_EXPIRES_SECONDS || '14400',
    10,
  ),
}));
