import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret',
};

interface ValidationOutcome {
  value: Record<string, unknown>;
  error?: Error;
}

const validate = (env: Record<string, string>): ValidationOutcome =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as ValidationOutcome;

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — object storage and queue', () => {
  it.each(['S3_ACCESS_KEY', 'S3_SECRET_KEY'])(
    'should reject a missing %s',
    (key) => {
      const env: Record<string, string> = { ...requiredEnv };
      delete env[key];

      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should apply the storage and queue defaults when only required keys are set', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'streamtube',
      S3_UPLOAD_PART_URL_EXPIRES_SECONDS: 3600,
      S3_DOWNLOAD_URL_EXPIRES_SECONDS: 14400,
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
    });
  });

  it('should reject a presigned URL lifetime above the 7-day SigV4 maximum', () => {
    const { error } = validate({ S3_DOWNLOAD_URL_EXPIRES_SECONDS: '604801' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_DOWNLOAD_URL_EXPIRES_SECONDS');
  });
});
