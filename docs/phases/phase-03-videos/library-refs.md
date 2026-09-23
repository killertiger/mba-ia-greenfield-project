---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-09-21T20:54:08-03:00"
  "bullmq":
    version: "^6.3.8"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-21T20:54:08-03:00"
  "ioredis":
    version: "^5.11.1"
    context7_id: "/redis/ioredis"
    fetched_at: "2026-09-23T09:35:41-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1137.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-21T20:54:08-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1137.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-21T20:54:08-03:00"
  "@aws-sdk/lib-storage":
    version: "^3.1137.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-21T20:54:08-03:00"
  "nanoid":
    version: "^3.3.19"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-09-21T20:54:08-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-21T21:00:10-03:00"
---

# Library References — Phase 03 (Upload e Processamento de Vídeos)

## Compatibility constraint (applies to every pin below)

`nestjs-project/` is a **CommonJS** package (no `"type"` field; `tsconfig` `module: nodenext`), and its tests run on Jest 30 + ts-jest 29, whose module runtime cannot `require()` ESM-only packages. Every pin below was chosen to resolve to a CommonJS entry point, verified on the npm registry:

| Package | Pinned | Why not latest |
|---------|--------|----------------|
| `@nestjs/bullmq` | `^11.0.5` | `12.0.0` is `"type": "module"` (ESM). `11.0.5` is CJS and its peers accept `bullmq ^3–^6` and `@nestjs/core ^10–^11`. |
| `bullmq` | `^6.3.8` | Latest; ships `dist/cjs`. |
| `ioredis` | `^5.11.1` | `6.0.0` is brand new; `5.x` is the mature line and is CJS (`"type": "commonjs"`, `main: ./built/index.js`). |
| `@aws-sdk/*` | `^3.1137.0` | Latest; `main` is `dist-cjs`. |
| `nanoid` | `^3.3.19` | `5.x` and `6.x` are ESM-only (Context7 `/ai/nanoid`: "CommonJS require syntax is not supported in Nanoid v6"). `3.x` exposes a `require` export (`index.cjs`). |

No library is pinned for TD-06: the worker spawns the `ffmpeg`/`ffprobe` binaries directly via Node's `child_process` (see TD-06 Note — `fluent-ffmpeg` is deprecated and, per its README, "no longer works properly with recent ffmpeg versions").

---

### @nestjs/bullmq

Used by: `phase-03-videos/TD-01` (queue), `TD-05` (worker consumer), `TD-12` (scheduler).

```typescript
// Root connection — async, from config (matches the project's registerAs/ConfigType convention)
BullModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: async (configService: ConfigService) => ({
    connection: {
      host: configService.get('QUEUE_HOST'),
      port: configService.get('QUEUE_PORT'),
    },
  }),
  inject: [ConfigService],
});

// Per-queue registration (name must be outside the factory in registerQueueAsync)
BullModule.registerQueue({ name: 'audio' });
```

```typescript
// Producer
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class AudioService {
  constructor(@InjectQueue('audio') private audioQueue: Queue) {}
}
```

```typescript
// Consumer (worker entrypoint, TD-05)
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('audio')
export class AudioConsumer extends WorkerHost {
  async process(job: Job<any, any, string>): Promise<any> {
    await job.updateProgress(50);
    return {};
  }
}
```

- `@InjectQueue()` name must match `registerQueue()`.
- Worker lifecycle events are available via `@OnWorkerEvent('failed' | 'completed' | ...)` on the processor class.

### bullmq

Used by: `TD-01`, `TD-09` (retry policy + idempotency), `TD-12` (job scheduler).

```typescript
// TD-09 revision: attempts 3, exponential backoff from 5s, jobId = video id
await queue.add(
  'process-video',
  { videoId },
  {
    jobId: videoId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
);
```

- **Deduplication by `jobId`:** jobs added with an identical `jobId` are treated as duplicates and not added. **Caveat (BullMQ docs):** with `removeOnComplete` / `removeOnFail`, a removed job no longer counts as existing, so a later `add` with the same `jobId` is accepted. TD-09's primary guard is therefore the video status (`409` when not `draft`); `jobId` is the second layer.
- **Failure after retries (BullMQ `src/classes/job.ts`):** a failed attempt is retried while `attemptsMade + 1 < opts.attempts` and the error is not an `UnrecoverableError`; `attemptsMade` is incremented after that decision. Do not assume the `failed` handler runs only once — guard the TD-09 write (`status = error` + `processing_error`) with `job.attemptsMade >= (job.opts.attempts ?? 1)`.
- **Non-retryable failures:** throwing `UnrecoverableError` (exported by `bullmq`) moves the job straight to failed without using the remaining attempts — the right signal when ffprobe shows a container/codec outside TD-11's allowlist, since retrying cannot fix the file.

```typescript
// TD-12: hourly sweep of abandoned drafts
await queue.upsertJobScheduler(
  'abandoned-upload-sweep',
  { every: 60 * 60 * 1000 },
  { name: 'sweep-abandoned-uploads', data: {} },
);
```

- `upsertJobScheduler(id, repeatOpts, template)` is idempotent per scheduler id — safe to call on every worker boot. `repeatOpts` accepts `every` (ms) or a cron `pattern`.

### ioredis

Used by: `TD-01` (queue backend) — **indirectly**. Nothing in `src/` imports `ioredis`; it is the Redis driver BullMQ instantiates from the connection options passed to `BullModule.forRootAsync`.

**Why it is pinned at all:** `bullmq@6` declares `ioredis` as an **optional peer** (`peerDependenciesMeta.ioredis.optional: true`, range `>=5.0.0`) and therefore does **not** install it. Without an explicit dependency the queue fails at runtime with *"BullMQ could not load the optional 'ioredis' package"* — which is exactly how it surfaced in SI-03.4, with both queue specs red. It was added to `dependencies` (not `devDependencies`): the API and the worker both need it in production.

```typescript
// How the connection is actually configured (src/queue/queue.module.ts).
// Plain options — BullMQ builds the ioredis client itself.
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (queue: ConfigType<typeof queueConfig>) => ({
    connection: { host: queue.redisHost, port: queue.redisPort },
  }),
});
```

- **`maxRetriesPerRequest` must be `null` for blocking clients** (workers). We do not set it: BullMQ assigns `this.opts.maxRetriesPerRequest = null` itself when it creates the connection from plain options (`bullmq/dist/cjs/classes/redis-connection.js:120`). The constraint only becomes ours if someone later passes a pre-built `new Redis(...)` instance instead — BullMQ then only warns (*"WARNING! Your redis options maxRetriesPerRequest must be null"*) and the worker misbehaves under connection loss. The ioredis default is `20` (Context7 `/redis/ioredis`).
- **Closing:** `quit()` waits for pending replies; `disconnect()` closes immediately and may drop them. Relevant to test teardown — closing the Nest app/module closes the queues, which is why the suites exit without leaking a Redis handle.
- Host comes from the Compose service name (`redis`), per the project's Docker networking rule.

### @aws-sdk/client-s3

Used by: `TD-02` (multipart orchestration), `TD-03`, `TD-04` (keys), `TD-10` (two clients), `TD-11` (post-completion check), `TD-12` (abort).

```typescript
// S3-compatible endpoint (MinIO) — TD-10 uses two instances: internal (server ops) + public (presigning only)
const client = new S3Client({
  endpoint: 'http://minio:9000',
  forcePathStyle: true,
  region: 'us-east-1',
  credentials: { accessKeyId: '...', secretAccessKey: '...' },
});
```

Commands relevant to this phase:

| Command | Required input | Returns / use |
|---------|---------------|---------------|
| `CreateMultipartUploadCommand` | `Bucket`, `Key` (+ `ContentType`) | `UploadId` — stored on the draft video (TD-02) |
| `UploadPartCommand` | `Bucket`, `Key`, `UploadId`, `PartNumber` (1–10000), `Body` | `ETag` — **presigned only**, the client PUTs the bytes (TD-02) |
| `CompleteMultipartUploadCommand` | `Bucket`, `Key`, `UploadId`, `MultipartUpload.Parts[{ ETag, PartNumber }]` | finalizes the object |
| `AbortMultipartUploadCommand` | `Bucket`, `Key`, `UploadId` | discards uploaded parts (TD-12 sweep) |
| `HeadObjectCommand` | `Bucket`, `Key` | `ContentLength` — 10GB / declared-size check (TD-11) |
| `GetObjectCommand` | `Bucket`, `Key` (+ `ResponseContentDisposition`) | presigned for streaming; `attachment` disposition for download (TD-08) |
| `DeleteObjectCommand` | `Bucket`, `Key` | removes a rejected upload (TD-11 revision) |

- S3 multipart rules: part numbers 1–10000; minimum part size 5 MiB except the last. TD-11 fixes 100 MiB parts.
- MinIO note (Context7 `/minio/docs`, S3 compatibility): the `AbortIncompleteMultipartUpload` lifecycle action is **not supported** with `PutBucketLifecycle` — hence TD-12's application-level sweep.

### @aws-sdk/s3-request-presigner

Used by: `TD-02` (part URLs), `TD-08` (GET URLs), `TD-10` (lifetimes).

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const url = await getSignedUrl(publicClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), {
  expiresIn: 3600, // TD-10: ~1h for part URLs
});

const streamUrl = await getSignedUrl(publicClient, new GetObjectCommand({ Bucket, Key }), {
  expiresIn: 14400, // TD-10: ~4h for GET URLs
});
```

- `expiresIn` defaults to **900 s** when omitted — always pass it explicitly from config.
- Signing is local (no network call); the signed host is the client's `endpoint`, which is why TD-10 presigns with the **public** endpoint client.
- `signableHeaders` / `unhoistableHeaders` options exist to force headers into the signature (TD-11 Option C, not chosen).

### @aws-sdk/lib-storage

Used by: `TD-03` (listed with the SDK). Not on the upload path (TD-02 is client-driven); candidate use is the worker writing the generated thumbnail.

```typescript
import { Upload } from '@aws-sdk/lib-storage';

const upload = new Upload({
  client,
  params: { Bucket, Key, Body }, // Body: Buffer | stream
  queueSize: 4,
  partSize: 1024 * 1024 * 5, // min 5MB
  leavePartsOnError: false,
});
upload.on('httpUploadProgress', (p) => {});
await upload.done();
```

- For a small thumbnail a single `PutObjectCommand` is sufficient; `Upload` is only needed for stream bodies of unknown length.

### nanoid

Used by: `TD-07` (public slug alongside the UUID PK).

```typescript
// CommonJS-compatible under the ^3 pin
import { customAlphabet } from 'nanoid';

const generateSlug = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  11,
);
const slug = generateSlug();
```

- Use the secure default import (`'nanoid'`), **not** `'nanoid/non-secure'` — the docs show the non-secure variant can collide in small batches.
- Default `nanoid()` is 21 chars (UUID v4-like collision odds); shorter slugs raise collision probability, so the column keeps a unique constraint and insertion retries on conflict.
