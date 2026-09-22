import { INestApplication, ValidationPipe } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { buildSwaggerDocument } from '../src/swagger/swagger-document';

interface OpenApiOperation {
  security?: Record<string, string[]>[];
  responses: Record<string, { content?: Record<string, unknown> }>;
}

interface OpenApiPath {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
}

async function createApp(withSwagger: boolean): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );

  if (withSwagger) {
    // Same builder as main.ts, so extraModels (the error envelope) are present.
    const document = buildSwaggerDocument(app);
    SwaggerModule.setup('api/docs', app, document, {
      customSiteTitle: 'StreamTube API Docs',
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.init();
  return app;
}

describe('Swagger endpoints (e2e)', () => {
  describe('when SWAGGER_ENABLED=true', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      process.env.SWAGGER_ENABLED = 'true';
      app = await createApp(true);
    });

    afterAll(async () => {
      await app.close();
      delete process.env.SWAGGER_ENABLED;
    });

    it('GET /api/docs returns 200 with HTML containing the custom title', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/docs')
        .expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('StreamTube API Docs');
    });

    it('GET /api/docs-json returns 200 with valid OpenAPI JSON', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/docs-json')
        .expect(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      const doc = res.body as Record<string, unknown>;
      expect((doc.info as Record<string, unknown>).title).toBe(
        'StreamTube API',
      );
      expect(
        (doc.components as Record<string, unknown>)?.securitySchemes as Record<
          string,
          unknown
        >,
      ).toMatchObject({
        'access-token': { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      });
    });

    it('documents the six video endpoints, each secured with the bearer scheme', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/docs-json')
        .expect(200);
      const paths = (res.body as { paths: Record<string, OpenApiPath> }).paths;

      const videoOperations: [string, keyof OpenApiPath][] = [
        ['/videos', 'post'],
        ['/videos/{slug}', 'get'],
        ['/videos/{slug}/upload/part-urls', 'post'],
        ['/videos/{slug}/upload/complete', 'post'],
        ['/videos/{slug}/stream', 'get'],
        ['/videos/{slug}/download', 'get'],
      ];

      for (const [path, method] of videoOperations) {
        const operation = paths[path]?.[method];
        expect(operation).toBeDefined();
        expect(operation!.security).toEqual(
          expect.arrayContaining([{ 'access-token': [] }]),
        );
      }
    });

    it('documents every response status of the upload completion endpoint', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/docs-json')
        .expect(200);
      const paths = (res.body as { paths: Record<string, OpenApiPath> }).paths;

      const operation = paths['/videos/{slug}/upload/complete'].post!;
      expect(Object.keys(operation.responses).sort()).toEqual([
        '202',
        '400',
        '401',
        '404',
        '409',
        '422',
      ]);

      // Error bodies all reference the shared domain error envelope.
      const conflict = operation.responses['409'].content?.[
        'application/json'
      ] as { schema?: { $ref?: string } } | undefined;
      expect(conflict?.schema?.$ref).toBe(
        '#/components/schemas/ApiErrorEnvelope',
      );
      const schemas = (
        res.body as { components: { schemas: Record<string, unknown> } }
      ).components.schemas;
      expect(schemas.ApiErrorEnvelope).toBeDefined();
    });

    it('matches the committed openapi.json', async () => {
      // Guards against the versioned spec drifting from the code.
      const res = await request(app.getHttpServer())
        .get('/api/docs-json')
        .expect(200);
      const committed = JSON.parse(
        readFileSync(join(__dirname, '..', 'openapi.json'), 'utf8'),
      ) as unknown;

      expect(res.body).toEqual(committed);
    });

    it('GET /api/docs-yaml returns 200 with YAML content', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/docs-yaml')
        .expect(200);
      expect(res.headers['content-type']).toMatch(/yaml/);
    });
  });

  describe('when SWAGGER_ENABLED is not set', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      delete process.env.SWAGGER_ENABLED;
      app = await createApp(false);
    });

    afterAll(async () => {
      await app.close();
    });

    it('GET /api/docs returns 404', async () => {
      await request(app.getHttpServer()).get('/api/docs').expect(404);
    });

    it('GET /api/docs-json returns 404', async () => {
      await request(app.getHttpServer()).get('/api/docs-json').expect(404);
    });

    it('GET /api/docs-yaml returns 404', async () => {
      await request(app.getHttpServer()).get('/api/docs-yaml').expect(404);
    });
  });
});
