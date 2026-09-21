---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 7
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-21T09:50:05-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-21T09:45:06-03:00"
issues:
  - id: IC-1
    status: open
    summary: "Testing guide says local-FS storage in tests; TD-02/03/04 decide real MinIO/S3"
  - id: AMB-1
    status: open
    summary: "Who may stream/download a video in Phase 03 (owner-only vs anyone; by status)?"
  - id: AMB-2
    status: open
    summary: "Which metadata fields are extracted and persisted besides duration?"
  - id: AMB-3
    status: open
    summary: "Status transition triggers and queue retry parameters left unspecified by TD-09"
  - id: MD-1
    status: open
    summary: "No TD on client-reachable storage endpoint used to sign presigned URLs"
  - id: MD-2
    status: open
    summary: "No TD on upload acceptance policy: 10GB enforcement, formats, part size"
  - id: MD-3
    status: open
    summary: "No TD on cleanup of abandoned uploads (orphan drafts + multipart parts)"
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `## Testing Requirements` carries the testing guide's external-systems strategy "Object Storage — guide text states 'Local Filesystem' adapter in dev/tests", while `phase-03-videos/TD-02`, `TD-03` and `TD-04` decide a real S3-compatible store (MinIO) driven by the AWS SDK v3 with presigned multipart uploads and a single bucket with `videos/{videoId}/...` keys. A local-filesystem adapter cannot exercise presigned multipart, `CompleteMultipartUpload`, or presigned GET URLs, so tests written per the guide would not cover the decided storage contract. The same block still lists Message Queue technology as "TBD", now resolved by `TD-01`. Explicit choice: (a) confirm that storage integration/e2e tests run against the real MinIO container in Compose (consistent with PostgreSQL/Mailpit being real) and record it — e.g. as a Revision on `TD-03` — so the testing guide's `references/external-systems.md` gets updated during implementation; or (b) keep a local adapter for unit-level tests only and state which layers hit MinIO.

### Ambiguities

- **AMB-1** — "Reprodução via streaming (sem necessidade de download completo)" and "Download do vídeo pelo usuário" do not say who may stream or download. `TD-08` decides the delivery mechanism (presigned GET URL) but not the authorization gate that decides whether a URL is issued. The boundary with the neighbors is unclear: video visibility (public/unlisted) belongs to Phase 04 and anonymous viewing plus the download button belong to Phase 05. It is also unstated whether a URL may be issued for a video that is not yet `ready` (`draft`/`processing`/`error`). Explicit choice: define the Phase 03 access rule — e.g. (a) authenticated owner only; (b) anyone with the public slug once `status = ready`, owner-only otherwise; (c) public for `ready` with no auth — plus the response for non-`ready` videos.
- **AMB-2** — "Processamento automático do vídeo após upload (extração de duração e metadados)" names only duration; "metadados" is open-ended. The Data Model (columns vs a JSON column) depends on which fields are persisted: resolution, codecs, bitrate, container format, file size, MIME type, etc. Explicit choice: list the metadata fields to persist and whether they go into typed columns or a single `jsonb` column.
- **AMB-3** — `TD-09` fixes the states (`draft | processing | ready | error`) and delegates retries to the queue, but leaves open: (i) the trigger for `draft → processing` — when the API completes the multipart upload and enqueues the job, or when the worker picks the job up; (ii) the queue retry parameters (attempts count, backoff type/delay) that decide when `error` is written; (iii) whether a repeated "complete upload" call re-enqueues work (job idempotency, e.g. job ID derived from the video ID). Explicit choice: fix the transition triggers and the retry/idempotency parameters, e.g. as a Revision on `TD-09`.

### Missing Decisions

- **MD-1** — "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" (`TD-02`) and "Reprodução via streaming" / "Download do vídeo pelo usuário" (`TD-08`) both rely on clients calling the object store directly with presigned URLs. Inside Compose the API and worker reach MinIO by service name, but a presigned URL is signed for a specific host, and a URL signed for the internal host is not reachable from outside the Docker network. No TD decides how the client-reachable storage endpoint is configured: a separate public endpoint for signing, a single endpoint reachable from both sides, or a proxy/CDN host. This is cross-component (env schema + `compose.yaml` + S3 client config + tests). Explicit choice: run `/research` (or resolve inline via `/plan-resolve`) to add a TD for internal vs public storage endpoint configuration, including presigned-URL expiry values for upload parts and GET URLs.
- **MD-2** — "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" sets a 10GB ceiling, but no TD decides how it is enforced under client-driven presigned multipart (`TD-02`). Open points: size declared by the client at initiation vs verified after completion (e.g. by checking the stored object's size); which containers/MIME types are accepted (this also determines whether progressive streaming under `TD-08` works in browsers without transcoding); and the part size, which fixes how many presigned part URLs the API issues and how the client splits the file. Explicit choice: add a TD (or extend `TD-02` via Revision) defining max-size enforcement, accepted formats, and part size.
- **MD-3** — "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" creates a `draft` row and an open multipart upload before any bytes arrive. No TD covers uploads the client abandons: orphan `draft` rows, and incomplete multipart parts that keep consuming storage. This also bears on the attention note "É importante planejar o crescimento e os custos de armazenamento desde o início". Explicit choice: add a TD on cleanup — e.g. (a) a storage lifecycle rule that aborts incomplete multipart uploads after N days; (b) an explicit abort endpoint plus a scheduled sweep of stale drafts; (c) accepted as a known gap for this phase.

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

_No issues resolved yet._
