---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-09-21
scope_description: "Video upload (up to 10GB, non-blocking), background processing (metadata + thumbnail via FFmpeg), object storage (MinIO/S3) organization, message queue technology, unique video URLs, and streaming/download delivery for Phase 03."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the video module: draft pre-registration on upload start, presigned upload orchestration, background processing (metadata + thumbnail), unique video URLs, streaming and download. New infrastructure (object storage, queue, worker) is provisioned here.
- `next-frontend/` — Out of scope for this phase. Per the phase brief, this is a backend-only challenge; the video interface belongs to a later phase. No open decision in this document, but several TDs below are marked `Cross-layer` because they define the API/URL contract a future frontend will consume.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram (`docs/diagrams/software-arch.mermaid`) marks the Message Queue container as "TBD" — this is the project's principal open stack decision for this phase. A broker is needed to hand off video-processing jobs (duration/metadata extraction, thumbnail generation) from the API to the Video Worker without blocking the request that registers the upload.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue. Official NestJS wrapper `@nestjs/bullmq` (npm `12.0.0`, peer-compatible with `@nestjs/core ^11.0.0`) provides `@Processor`/`@OnWorkerEvent` decorators, DI-friendly queue registration, and BullMQ's native `attempts` + exponential `backoff` job options.
- **Pros:** Most mature retry/backoff/progress feature set of the three (confirmed via docs: `worker.on('failed', ...)`, `attempts`/`backoff` job options) — directly answers "what happens on processing failure". First-class, actively maintained NestJS integration. Large ecosystem (dashboards like Bull Board for observability).
- **Cons:** Introduces Redis as a brand-new infrastructure dependency not yet in `compose.yaml`.

### Option B: RabbitMQ (`@golevelup/nestjs-rabbitmq` or `@nestjs/microservices` RMQ transport)
- AMQP broker. `@golevelup/nestjs-rabbitmq` (npm `9.0.2`) offers decorator-based publishers/consumers on top of `amqplib`.
- **Pros:** Standard, durable pub/sub broker; well suited to fan-out patterns if the platform later needs multiple consumers per job type.
- **Cons:** Also a brand-new infra dependency (same cost as Option A, no infra savings). `@nestjs/microservices`' RMQ transport is oriented to request/response microservice calls, not job-queue semantics — retry/backoff/progress must be hand-rolled on top of raw AMQP acks/nacks, more code for the same outcome Option A gets natively.

### Option C: pg-boss (PostgreSQL-backed queue)
- Node-native job queue that stores jobs in the existing PostgreSQL 17 database (`pg-boss`, npm `12.33.3`) — no new broker service.
- **Pros:** Zero new infrastructure — reuses the `db` service already in `compose.yaml`, echoing the phase-02 precedent of preferring Postgres over Redis (TD-03 refresh-token rotation). Supports retries and backoff.
- **Cons:** No official NestJS wrapper (must be wired manually as a provider). Relies on DB polling/`LISTEN`+`NOTIFY` rather than a purpose-built broker; less field-tested for worker-fleet scale than BullMQ. Adds background polling load to the same Postgres instance serving the API.

**Recommendation:** **Option A (BullMQ + Redis)** — The phase brief explicitly frames the queue as the "principal decisão de stack da fase" expecting dedicated infrastructure, not a workaround to avoid it. BullMQ's native `attempts`/`backoff`/`failed`-event API maps directly onto TD-09's failure-handling requirement with the least custom code, and `@nestjs/bullmq` is an officially maintained package confirmed compatible with the installed NestJS 11.

**Decision:** A: BullMQ + Redis (`@nestjs/bullmq`)
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-02: Upload Protocol for Files up to 10GB

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** This is the central architecture decision flagged by the challenge brief. The upload must not block the API's event loop/memory regardless of file size, and `docs/project-plan.md`'s Pontos de Atenção additionally asks that a dropped connection be resumable rather than restarting the whole transfer. The chosen protocol dictates how the client (today: test tooling/Swagger; later: the Next.js frontend) talks to the API during upload — hence `Cross-layer`.

**Options:**

### Option A: Presigned S3/MinIO Multipart Upload (client-driven)
- The API only orchestrates: it calls `CreateMultipartUploadCommand`, issues a presigned URL per part via `getSignedUrl` (`@aws-sdk/s3-request-presigner`, confirmed to work against S3-compatible endpoints) for fixed-size chunks (e.g. 50–100MB), and calls `CompleteMultipartUploadCommand` once the client reports all part ETags. The client uploads each part's bytes directly to MinIO — the API never touches file bytes.
- **Pros:** API load/memory is independent of file size — no bottleneck regardless of concurrent uploads. Natural resumability: a failed part can be retried individually without restarting the transfer. Native S3/MinIO feature, no extra infrastructure.
- **Cons:** Moves orchestration complexity (splitting the file, tracking ETags, retrying failed parts) to the client — a real cost for the future frontend implementation.

### Option B: tus Resumable Protocol
- Open resumable-upload standard. Requires either a `tusd` sidecar (Go binary with an S3 storage backend) as a new Docker service, or an unofficial/unmaintained Node tus server.
- **Pros:** True byte-level resumability (can resume mid-chunk, not only between parts).
- **Cons:** Heaviest infra option — a whole new service (`tusd`) whose S3 backend performs multipart upload internally anyway, so it doesn't add real capability over Option A for this project. No mature, actively maintained NestJS-native abstraction.

### Option C: Streaming Passthrough Through the API
- The API accepts the `multipart/form-data` upload as a Node stream (e.g. via `busboy`), never buffering to memory/disk, and pipes it directly into `@aws-sdk/lib-storage`'s `Upload` class (confirmed: accepts a stream `Body`, performs concurrent multipart internally).
- **Pros:** Simplest client implementation — a single HTTP request, no client-side chunk orchestration.
- **Cons:** All bytes still flow through the API process on one long-lived connection — a network blip restarts the whole upload, and concurrent large uploads still consume API connections/CPU proportional to traffic. This is exactly the pattern the challenge names as an automatic-fail condition ("Passar o arquivo de 10GB pela API de forma que trave o sistema").

**Recommendation:** **Option A (Presigned S3/MinIO Multipart Upload)** — It is the only option that fully removes file bytes from the API's path while adding no new infrastructure beyond the already-mandated MinIO, and it gives resumability as a side effect of chunking rather than requiring a dedicated resumable-upload server.

**Decision:** A: Presigned S3/MinIO Multipart Upload (client-driven)

---

## TD-03: S3/MinIO Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The object storage technology itself is not open (the project mandates an S3-compatible store — MinIO locally, S3 in production, per the challenge brief). What is open is which client library the API and worker use to talk to it, which directly affects how portable the code is to real AWS S3 later and how TD-02's presigned-multipart flow gets implemented.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` + `@aws-sdk/lib-storage`)
- Official, modular AWS SDK. `S3Client` works against any S3-compatible endpoint (override `endpoint`/`forcePathStyle`/`credentials`). Confirmed via docs: `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, and `getSignedUrl` map directly onto TD-02's presigned-multipart orchestration.
- **Pros:** Zero-code-change portability to real AWS S3 in production — directly matches the project's "MinIO now, S3 later" framing. Low-level commands map 1:1 to the multipart flow this phase needs. Largest ecosystem/long-term support.
- **Cons:** More verbose command-pattern API. Three separate packages to install.

### Option B: Official MinIO JS Client (`minio` npm)
- MinIO's own SDK (npm `8.0.7`). High-level API: `presignedPutObject`, `presignedGetObject`, `makeBucket`, `fPutObject`, with built-in transparent multipart handling for large files.
- **Pros:** Simplest API surface; built by the same team as the storage server, so compatibility is guaranteed by design. Single package.
- **Cons:** The part-by-part presigned multipart primitive (`uploadPart`) needed for TD-02 is an internal/lower-level API, not the prominently documented public surface (unlike the AWS SDK's equivalent commands). Migrating to real AWS S3 in production is "should work" via S3 compatibility rather than AWS's own supported path.

**Recommendation:** **Option A (AWS SDK v3)** — Since the project explicitly frames MinIO as a stand-in for production S3, using AWS's own SDK removes migration risk entirely, and its documented multipart commands are exactly the primitives TD-02's client-driven presigned flow needs.

**Decision:** A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` + `@aws-sdk/lib-storage`)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @aws-sdk/lib-storage

**Revisions:**
- 2026-09-21 — Storage integration and e2e tests run against the real MinIO container in Compose — no local-filesystem adapter; unit tests mock the storage service at the module boundary. `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` is updated during implementation to match. Rationale: IC-1 — presigned multipart, `HeadObject`, `AbortMultipartUpload` and ranged presigned GETs cannot be exercised by a local adapter; aligns with PostgreSQL/Mailpit already being tested for real.

---

## TD-04: Storage Key & Bucket Organization

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "URL única por vídeo, sem conflito com outros vídeos"

**Context:** Once a client (S3/MinIO) library is chosen (TD-03), the bucket layout and object-key naming convention must be defined — this is referenced by the video entity's storage columns, the worker (which writes the thumbnail after processing), and the streaming/download delivery (TD-08).

**Options:**

### Option A: Single bucket, type-prefixed keys
- One bucket (e.g. `streamtube`), keys namespaced by video ID and asset type: `videos/{videoId}/original.<ext>`, `videos/{videoId}/thumbnail.jpg`.
- **Pros:** Single bucket to provision (CORS, presigned-URL base) in MinIO. All of a video's assets live under one deletable prefix — simplifies bulk operations (e.g. deleting a video). Common S3 convention for multi-asset objects.
- **Cons:** Mixes access patterns (large video reads vs. small thumbnail reads) in one bucket — no practical downside at this project's scale.

### Option B: Separate buckets per asset type
- `streamtube-videos` and `streamtube-thumbnails` as distinct buckets.
- **Pros:** Allows different lifecycle/access policies per bucket without per-object ACLs (e.g. public-read thumbnails vs. signed-only videos).
- **Cons:** Doubles the bucket-bootstrap logic in the compose init step. The access-policy differentiation this buys isn't needed yet — video visibility (public/unlisted) is explicitly Phase 04 scope, not this phase.

**Recommendation:** **Option A (single bucket, `videos/{videoId}/...` prefixes)** — Minimizes MinIO bootstrap for this phase and groups a video's assets under one prefix; Option B's access-policy benefit is not needed until Phase 04 introduces public visibility, and can be adopted later via bucket policy changes without a key-layout migration.

**Decision:** A: Single bucket, type-prefixed keys

---

## TD-05: Worker Application Architecture

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The architecture diagram already establishes a separate "Video Worker (FFmpeg)" container distinct from the API — that separation is not re-opened here. What is open is how the worker is built: how much of the existing NestJS codebase (entities, config, DI) it reuses versus reimplements.

**Options:**

### Option A: NestJS Standalone Application Context (separate entrypoint, same codebase)
- A second bootstrap file (e.g. `src/worker.ts`) using `NestFactory.createApplicationContext(WorkerModule)` — no HTTP listener — built from the same image/Dockerfile as the API with a different `CMD`, running as its own Compose service. `WorkerModule` imports only what processing needs (`VideosModule`, `TypeOrmModule`/`DatabaseModule`, a `StorageModule`), registering the queue's processor/consumer.
- **Pros:** Full DI/entity/config reuse — no duplicated TypeORM entities or env validation (Joi schema). Matches the diagram's separate-container requirement while keeping one codebase. Testable with the same `@nestjs/testing` patterns already used elsewhere in the project.
- **Cons:** Must scope `WorkerModule`'s imports carefully so the worker doesn't drag in unrelated modules (e.g. `MailerModule`) it doesn't need.

### Option B: Plain Node.js Worker Script (no NestJS)
- Hand-rolled script using the chosen queue client directly, with its own DB access and storage calls outside Nest's module system.
- **Pros:** Smaller runtime footprint, no Nest bootstrap overhead.
- **Cons:** Duplicates entity/config logic already defined for the API — violates the project's Single Responsibility/no-duplication working principle. Loses the DI-based testability the rest of the codebase relies on. Introduces a second coding pattern in the same repository.

### Option C: In-Process Worker (same container as the API)
- Register the queue processor directly inside the existing API process — no separate container.
- **Pros:** No new Docker service.
- **Cons:** Contradicts the already-decided architecture diagram (Video Worker is its own container). CPU-heavy FFmpeg work would compete with the API's event loop/HTTP handling for CPU, undermining the same non-blocking principle behind TD-02. Cannot scale worker replicas independently of the API.

**Recommendation:** **Option A (NestJS Standalone Application Context)** — The only option consistent with the already-decided separate-container architecture while maximizing code reuse; `NestFactory.createApplicationContext` is an official, documented technique for non-HTTP entrypoints sharing a Nest codebase.

**Decision:** A: NestJS Standalone Application Context (separate entrypoint, same codebase)

---

## TD-06: Video Processing — FFmpeg/ffprobe Integration

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker (TD-05) needs to extract duration/metadata and generate a thumbnail from a video frame. Both capabilities depend on the `ffmpeg`/`ffprobe` binaries; the open question is how the Node worker code invokes them.

**Options:**

### Option A: `fluent-ffmpeg` wrapper library
- Node wrapper (npm `2.1.3`) exposing `ffmpeg.ffprobe(path, cb)` for metadata/duration (returns structured `streams`/`format` JSON — confirmed to include `format.duration`, `streams[].width/height/codec_name`) and `.screenshots({ timestamps, folder, size })` for frame-based thumbnail generation.
- **Pros:** One dependency covers both required capabilities with a documented API, avoiding hand-built CLI argument construction (a common source of subtle bugs, e.g. correct `-ss` placement for accurate seeking).
- **Cons:** Still requires the `ffmpeg`/`ffprobe` binaries installed in the worker's Docker image (`apt-get install ffmpeg`) — the wrapper does not bundle them.

### Option B: Direct `child_process.spawn` of `ffmpeg`/`ffprobe`
- Spawn `ffprobe -print_format json -show_format -show_streams <file>` for metadata and `ffmpeg -ss <t> -i <file> -frames:v 1 <out.jpg>` for the thumbnail, parsing stdout manually.
- **Pros:** No extra npm dependency; full control over CLI flags.
- **Cons:** Reimplements argument construction, stdout JSON parsing, and process-lifecycle/error handling that `fluent-ffmpeg` already provides — more code to write and test for no functional gain.

**Recommendation:** **Option A (`fluent-ffmpeg`)** — It covers both capabilities (`ffprobe` for metadata, `.screenshots()` for thumbnail) with less custom code; the `ffmpeg`/`ffprobe` binary dependency in the worker's Docker image is unavoidable either way, so the wrapper only removes CLI-argument/parsing burden, at no real cost.

**Decision:** B: Direct child_process spawn of ffmpeg/ffprobe

**Note:** Decision changed from A (`fluent-ffmpeg`) to B during `/plan-resolve` (2026-09-21) and deliberately diverges from the Recommendation. The official `fluent-ffmpeg` README (via Context7, `/fluent-ffmpeg/node-fluent-ffmpeg`) states the library "is no longer maintained and no longer works properly with recent ffmpeg versions", and npm marks 2.1.3 deprecated; the worker image installs a current `ffmpeg` from apt, so Option A's main premise no longer holds. The alternatives Context7 surfaced were rejected: the `thedave42` fork installs as the same deprecated `fluent-ffmpeg` package, and `ffmpeg-kit` (`@ffmpeg-sdk/core`) is ESM-only at 0.1.0, which the CommonJS + Jest/ts-jest backend cannot load. The worker runs `ffprobe -v error -print_format json -show_format -show_streams <file>` for metadata and `ffmpeg -ss <t> -i <file> -frames:v 1 <thumb>` for the thumbnail, behind its own service so callers never see the CLI.

**Revisions:**
- 2026-09-21 — Persisted metadata: typed columns `duration_seconds`, `width`, `height`, `size_bytes`, `mime_type`; a `jsonb` `metadata` column holds the remaining ffprobe fields (video/audio codecs, bitrate, container format, frame rate). Rationale: AMB-2 — typed columns for fields later phases list or filter on, jsonb for descriptive fields that would otherwise churn the schema.

---

## TD-07: Unique Video URL Identifier Strategy

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** `docs/project-plan.md`'s Pontos de Atenção explicitly asks for a **short** and unique URL per video ("cada vídeo precisa de uma URL curta e única"). This identifier is part of the API/routing contract the future frontend (video page, Phase 05) will consume directly.

**Options:**

### Option A: UUID v4 (same pattern as `users`/`channels`)
- `@PrimaryGeneratedColumn('uuid')`, identical to the existing `User`/`Channel` entities.
- **Pros:** Zero new dependency; consistent with every existing entity in the codebase; negligible collision risk.
- **Cons:** 36 characters — does not satisfy the literal "URL curta" requirement. Random ordering causes more B-tree index page splits on insert as the `videos` table grows, versus a time-ordered key.

### Option B: UUID v7 (time-ordered)
- Time-ordered UUID (RFC 9562) — same 36-char format and uniqueness guarantee as v4, but with insert-friendly index locality.
- **Pros:** Same length/uniqueness as v4 with better index locality for a table expected to grow large with frequent writes.
- **Cons:** Still 36 characters — does not address "URL curta" either. Requires app-side v7 generation (not a drop-in Postgres 17 default), a small deviation from the existing UUID-default column pattern.

### Option C: Short opaque ID via `nanoid` (as a dedicated public slug, alongside a UUID primary key)
- The entity keeps a standard UUID primary key (for FK relations, consistent with every other entity), plus a separate short, URL-safe `nanoid` (npm `6.0.1`) column used as the public identifier (e.g. `/videos/V1StGXR8`).
- **Pros:** The only option that actually satisfies "URL curta e única" — a 10–12 char slug is meaningfully shorter than any UUID variant, while remaining collision-resistant at this project's realistic volume.
- **Cons:** Introduces a second identifier column (public slug ≠ internal PK) and a new dependency; adds one uniqueness constraint to maintain.

**Recommendation:** **Option C (`nanoid` public slug + UUID primary key)** — It is the only option that satisfies the literal short-URL requirement from `docs/project-plan.md`; UUID v4/v7 both remain 36 characters regardless of ordering. The dual-identifier pattern (internal PK vs. public-facing slug) is a small, well-precedented addition that leaves the existing UUID-PK convention untouched.

**Decision:** C: Short opaque ID via `nanoid` (as a dedicated public slug, alongside a UUID primary key)
**Libraries:** nanoid

---

## TD-08: Video Delivery Strategy (Streaming & Download)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** The architecture diagram already draws `Rel(frontend, storage, "Streams", "HTTPS")` — the frontend is expected to stream directly from object storage, not through the API. This TD decides whether to follow that relationship or have the API mediate playback/download bytes.

**Options:**

### Option A: Presigned GET URL, direct-to-storage
- The video's detail response includes a presigned MinIO/S3 GET URL (`getSignedUrl` + `GetObjectCommand`, confirmed above) with a bounded expiry (e.g. a few hours). The browser's `<video>` element (or a download link) points directly at that URL. MinIO/S3 natively supports HTTP `Range` requests and returns `206 Partial Content` — core S3 behavior, no app code required. Setting `ResponseContentDisposition=attachment` on the same presign call forces a download instead of inline playback, so streaming and download share one mechanism.
- **Pros:** Matches the already-decided architecture diagram exactly. Zero bytes flow through the API for playback/download, regardless of concurrent viewers — continues the same non-blocking principle as TD-02's upload path. Range/206 behavior is free (native to storage).
- **Cons:** Presigned URL expiry must be tuned for realistic viewing sessions (mitigated with a generous expiry; a fresh URL is cheap to re-request). MinIO/S3 must be network-reachable by the client (already implied by the diagram).

### Option B: API-proxied streaming
- `GET /videos/:id/stream` on the API reads the incoming `Range` header, fetches the matching byte range from storage, and re-streams it with `206 Partial Content`.
- **Pros:** The API can enforce authorization/analytics per byte-range request without exposing storage URLs directly.
- **Cons:** Contradicts the architecture diagram's explicit `frontend → storage` streaming relationship. Every playback second and download byte flows through the API — the exact sustained-bandwidth load the non-blocking principle (also behind TD-02) argues against. The API becomes a bandwidth bottleneck as concurrent viewers grow.

**Recommendation:** **Option A (Presigned GET URL, direct-to-storage)** — It is the direct continuation of TD-02's non-blocking principle applied to reads, and it is literally what the C4 diagram already specifies; Option B would contradict an already-decided diagram relationship rather than propose a genuinely open alternative.

**Decision:** A: Presigned GET URL, direct-to-storage

**Revisions:**
- 2026-09-21 — Phase 03 access rule: only the authenticated owner of the video's channel obtains streaming/download URLs; requesting URLs for a video whose status is not `ready` returns a domain error (HTTP 409). Wider access is left to later phases. Rationale: AMB-1 — video visibility (public/unlisted) belongs to Phase 04 and anonymous viewing to Phase 05.

---

## TD-09: Video Status Lifecycle & Processing Failure Policy

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** `docs/project-plan.md` names the status cycle explicitly (rascunho → processando → pronto/erro) and the challenge brief asks what happens on processing failure. The status enum is also part of the API contract a future frontend (Phase 04 management panel) will render as a badge.

**Options:**

### Option A: Minimal 4-state enum, no persisted failure detail
- `VideoStatus`: `draft | processing | ready | error`. On worker failure, the queue's own retry mechanism (TD-01) retries automatically per its configured attempts/backoff; only after all attempts are exhausted does the worker set `status = 'error'`. No error-detail column.
- **Pros:** Simplest schema — one enum column; matches the four states named literally in `docs/project-plan.md`.
- **Cons:** An `error` video gives a future admin panel nothing beyond "failed" — no way to distinguish failure causes without checking worker/queue logs directly.

### Option B: Same 4 states + persisted failure reason + queue-native retries
- Same enum as Option A, plus a nullable `processing_error` text column populated by the worker when the job's final attempt fails (BullMQ's `worker.on('failed', ...)` event fires exactly once all configured `attempts` are exhausted — confirmed above — giving a single, well-defined write point). Retries themselves are fully delegated to the chosen queue's built-in attempts/backoff — no custom retry loop in application code.
- **Pros:** One extra column buys real diagnosability for developers and a future admin UI. Retry logic is entirely delegated to infrastructure already required by TD-01, with no bespoke retry state machine to build or test.
- **Cons:** No user-facing "retry this video" action in this phase (out of scope — Phase 04 owns video management); a permanently `error` video requires a new upload, which is an acceptable fallback given corrupt-file failures are effectively unrecoverable anyway.

### Option C: Extra `uploaded` state between `draft` and `processing`
- Adds a distinct `uploaded` status representing "upload finished, job enqueued but not yet started."
- **Pros:** More granular observability — distinguishes "still uploading" from "uploaded, waiting for the worker."
- **Cons:** Not requested by the literal wording in `docs/project-plan.md`. The window it represents is typically milliseconds under normal load, adding a state both frontend and tests must handle for a transition most users will never observe.

**Recommendation:** **Option B** — It answers the "what happens on processing failure" question from the challenge with a concrete, low-cost mechanism (persisted `processing_error` + queue-native retries), without building a manual-retry API surface that belongs to a later phase's video-management scope.

**Decision:** B: Same 4 states + persisted failure reason + queue-native retries

**Revisions:**
- 2026-09-21 — `draft → processing` happens when the API completes the multipart upload: it sets `status = processing` and enqueues the processing job with `jobId` = video id in the same flow; a repeated "complete upload" call on a non-`draft` video returns a domain error (HTTP 409), and the deterministic job id prevents duplicate jobs. Queue retries: `attempts: 3`, exponential backoff starting at 5s; `status = error` + `processing_error` are written when the last attempt fails. Rationale: AMB-3 (i)–(iii) — status reflects "upload done, processing pending" immediately, and idempotency relies on the queue's job id rather than extra locking.

---

## TD-10: Storage Endpoint Configuration for Presigned URLs

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** TD-02 (presigned multipart upload) and TD-08 (presigned GET for streaming/download) both require the client to call the object store directly. SigV4 presigned URLs embed and sign the host they were generated for, so the host must be the one the client actually reaches. Inside Compose the API and worker must reach MinIO by service name (`minio`), per the project's Docker networking rule — but `http://minio:9000` is not resolvable from a browser or host tool. This decision fixes how the internal and client-facing endpoints are configured, which spans the env schema (Joi), `compose.yaml`, `.env.example`, the S3 client provider and the tests. It also fixes presigned URL lifetimes, which the upload client and player depend on.

**Options:**

### Option A: Two endpoints — internal for server operations, public for presigning
- Two env keys (e.g. `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`). Server-side commands (`CreateMultipartUpload`, `CompleteMultipartUpload`, `HeadObject`, worker reads/writes) use a client bound to the internal endpoint; a second `S3Client` bound to the public endpoint is used only for `getSignedUrl`, which computes signatures locally without a network call. In tests that run inside the container, the public endpoint is set equal to the internal one so the test itself can PUT/GET the presigned URLs.
- **Pros:** Honors the service-name rule for every container-to-container call; the public host is pure configuration, so production swaps it for the S3/CDN host with no code change; no new service.
- **Cons:** Two endpoint values to keep coherent per environment; a misconfigured public endpoint yields `SignatureDoesNotMatch`/unreachable URLs only at runtime (mitigated by an e2e test that follows a presigned URL).

### Option B: Single endpoint hostname reachable from both sides
- One `S3_ENDPOINT` used everywhere (e.g. `http://minio:9000`), made resolvable on the host via `/etc/hosts` or `host.docker.internal`-style aliases.
- **Pros:** One S3 client, one config value.
- **Cons:** Requires per-machine, OS-dependent host configuration outside the repo — not reproducible by `docker compose up` alone; breaks for any client the team does not control.

### Option C: Reverse proxy service with a stable public origin
- Add a proxy container (e.g. nginx) in Compose exposing one public origin that forwards to MinIO, preserving the `Host` header so signatures validate; the SDK presigns against the proxy origin.
- **Pros:** Production-like single origin; could also front the API later.
- **Cons:** New infrastructure service and config for a problem Option A solves with one env key; `Host`-header preservation is an extra, easy-to-break signature dependency.

**Recommendation:** **Option A (Two endpoints)** — It keeps every container-to-container call on the Compose service name as the project rule requires, while making the client-facing host explicit configuration that maps directly to S3/CDN in production. Proposed lifetimes: upload part URLs short-lived (e.g. 1h — a client resuming after expiry requests fresh URLs for the remaining parts), GET URLs longer (e.g. 4h, covering a long viewing session per TD-08), both as env-configurable values validated by Joi.

**Decision:** A: Two endpoints — internal for server operations, public for presigning

---

## TD-11: Upload Acceptance Policy (Size Enforcement, Formats, Part Size)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** Under TD-02 the client sends bytes straight to storage, so the API cannot count bytes as they arrive. The 10GB ceiling, the accepted formats and the part size must be enforced through the initiation request, storage-side checks, and the worker. Formats matter for streaming: TD-08 serves the original file directly (no transcoding step exists in this phase's capabilities), so only containers/codecs browsers play natively stream correctly. Part size is a client↔API contract: it decides how many presigned part URLs the API issues and how the client splits the file (S3 multipart rules: part numbers 1–10000, minimum 5 MiB per part except the last).

**Options:**

### Option A: Declared metadata validated at initiation only
- The client declares file size and MIME type when starting the upload (the same request that pre-registers the draft). The API rejects `size > 10GB` or a MIME outside the allowlist, then issues part URLs for a server-fixed part size. No check after completion.
- **Pros:** Simplest; a single validation point; no extra storage calls.
- **Cons:** Advisory only — a client can upload more bytes, or a different format, than declared, and nothing catches it before processing.

### Option B: Declared at initiation + verified after completion
- As Option A, plus two post-upload checks: on "complete upload" the API calls `HeadObject` and rejects (and deletes the object) when `ContentLength` exceeds 10GB or differs from the declared size; the worker's `ffprobe` (TD-06) confirms the real container/codec is in the allowlist, otherwise the video goes to `error` with `processing_error` set (TD-09).
- **Pros:** The limit and format are actually enforced, using only primitives already in the stack (AWS SDK `HeadObject`, ffprobe); failure paths reuse TD-09's `error` state.
- **Cons:** Oversized or invalid bytes land in storage briefly before being rejected and deleted; two validation points to test.

### Option C: Option B + storage-enforced part sizes
- As Option B, plus each `UploadPart` URL is presigned with a signed `content-length` (via `getSignedUrl`'s `signableHeaders` option, documented in `@aws-sdk/s3-request-presigner`), so storage rejects any part that is not exactly the expected size. The total can therefore never exceed parts × part size.
- **Pros:** Excess bytes never reach storage.
- **Cons:** The client can no longer choose its chunking, and the last part's exact length must be computed per upload; MinIO's handling of a signed `content-length` on presigned `UploadPart` is not documented in the sources consulted and would need verification; the most complex of the three.

**Recommendation:** **Option B** — It turns the 10GB limit and the format allowlist into enforced rules using `HeadObject` and ffprobe, which the stack already needs, without depending on unverified MinIO signature behavior (Option C) or trusting the client (Option A). Proposed parameters: allowlist `video/mp4` and `video/webm` (browser-playable without transcoding, which TD-08's direct streaming requires); server-fixed part size of 100 MiB (≈103 parts for 10GB, well inside the 10000-part limit), returned to the client in the initiation response.

**Decision:** B: Declared at initiation + verified after completion

**Revisions:**
- 2026-09-21 — When the post-completion `HeadObject` check rejects an upload (size > 10GB or different from the declared size), the object is deleted, the video moves to `status = error` with `processing_error` recording the rejection, and the API responds HTTP 422 with a domain error code. Rationale: AMB-3 (iv) — keeps TD-09's four states as the single lifecycle and preserves an audit trail of the failed attempt.

---

## TD-12: Abandoned Upload Cleanup

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** Pre-registering the draft when the upload starts (TD-02) creates a `draft` row and an open multipart upload before any bytes arrive. If the client never completes — closed tab, lost connection, crash — the uploaded parts keep occupying storage and the draft stays forever. `docs/project-plan.md`'s Pontos de Atenção asks to plan storage growth and cost from the start.

**Options:**

### Option A: Scheduled sweep via a BullMQ job scheduler in the worker
- A repeatable job (BullMQ `upsertJobScheduler` with an `every` interval, confirmed in the BullMQ docs) runs in the worker (TD-05). It finds `draft` videos whose upload started more than N hours ago and was never completed, calls `AbortMultipartUpload` for each, and moves the row to `error` with `processing_error` recording the abandonment (reusing TD-09's states — no new status).
- **Pros:** Behaves the same on MinIO and S3; cleans storage and database together; reuses infrastructure already decided (TD-01 queue, TD-05 worker).
- **Cons:** One more scheduled job with its own tests; an abandonment TTL must be chosen (it must exceed the longest legitimate upload).

### Option B: Storage-native lifecycle rule
- Configure an `AbortIncompleteMultipartUpload` lifecycle rule on the bucket.
- **Pros:** No application code.
- **Cons:** MinIO's S3-compatibility docs state this lifecycle action is not supported with `PutBucketLifecycle`, so it would work on S3 but not on the local MinIO stack; it also never touches the orphan `draft` rows.

### Option C: Client-initiated abort endpoint only
- An endpoint the client calls to cancel an in-progress upload (aborts the multipart upload and removes/marks the draft).
- **Pros:** Minimal and explicit.
- **Cons:** Does not cover the main failure mode — clients that disappear without calling anything.

### Option D: Accept as a known gap for this phase
- Document that abandoned uploads are not cleaned yet and defer cleanup to Phase 04 (video management).
- **Pros:** Adds no scope to Phase 03.
- **Cons:** Orphan parts and drafts accumulate from the first day of use, contrary to the storage-cost attention note.

**Recommendation:** **Option A (Scheduled sweep)** — It is the only option that works identically on the local MinIO stack and on S3 while cleaning both storage and the draft rows, and it adds no infrastructure beyond TD-01/TD-05. MinIO's own server-side expiry of stale uploads was not confirmed in the sources consulted, so it is not relied on. Option D is the fallback if the team prefers not to add scope to this phase.

**Decision:** A: Scheduled sweep via a BullMQ job scheduler in the worker

**Revisions:**
- 2026-09-21 — Abandonment TTL: 24h — drafts whose upload started more than 24h ago and never completed are swept; the job scheduler runs hourly. Rationale: AMB-3 (v) — covers slow 10GB uploads that resume by requesting fresh part URLs after the ~1h part-URL expiry (TD-10).

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ + Redis | A: BullMQ + Redis (`@nestjs/bullmq`) |
| TD-02 | Cross-layer | Upload Protocol for Files up to 10GB | Presigned S3/MinIO Multipart Upload | A: Presigned S3/MinIO Multipart Upload (client-driven) |
| TD-03 | Backend | S3/MinIO Client Library | AWS SDK v3 | A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` + `@aws-sdk/lib-storage`) |
| TD-04 | Backend | Storage Key & Bucket Organization | Single bucket, type-prefixed keys | A: Single bucket, type-prefixed keys |
| TD-05 | Backend | Worker Application Architecture | NestJS Standalone Application Context | A: NestJS Standalone Application Context (separate entrypoint, same codebase) |
| TD-06 | Backend | Video Processing — FFmpeg/ffprobe Integration | `fluent-ffmpeg` | B: Direct child_process spawn of ffmpeg/ffprobe |
| TD-07 | Cross-layer | Unique Video URL Identifier Strategy | `nanoid` public slug + UUID PK | C: Short opaque ID via `nanoid` (as a dedicated public slug, alongside a UUID primary key) |
| TD-08 | Cross-layer | Video Delivery Strategy (Streaming & Download) | Presigned GET URL, direct-to-storage | A: Presigned GET URL, direct-to-storage |
| TD-09 | Cross-layer | Video Status Lifecycle & Processing Failure Policy | 4 states + persisted failure reason + queue-native retries | B: Same 4 states + persisted failure reason + queue-native retries |
| TD-10 | Cross-layer | Storage Endpoint Configuration for Presigned URLs | Two endpoints (internal + public for presigning) | A: Two endpoints — internal for server operations, public for presigning |
| TD-11 | Cross-layer | Upload Acceptance Policy (Size Enforcement, Formats, Part Size) | Declared at initiation + verified after completion | B: Declared at initiation + verified after completion |
| TD-12 | Backend | Abandoned Upload Cleanup | Scheduled sweep via BullMQ job scheduler | A: Scheduled sweep via a BullMQ job scheduler in the worker |
