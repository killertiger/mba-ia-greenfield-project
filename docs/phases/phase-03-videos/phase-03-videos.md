---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-21T21:02:47-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-21T21:02:54-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-21T21:00:10-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-21T09:04:47-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload of files up to 10GB without routing bytes through the API (presigned multipart straight to object storage), automatic pre-registration of the video as a draft when the upload starts, background processing in a separate worker that extracts duration/metadata and generates a thumbnail from a video frame, a short unique URL per video, and streaming plus download served directly from storage — with MinIO, Redis/BullMQ and the video worker running in Docker Compose alongside the API.

---

## Step Implementations

### SI-03.1 — Infra: dependências, configuração e serviços MinIO/Redis no Compose

**Description:** Instalar as bibliotecas da fase, criar os namespaces de configuração de storage e fila, e subir MinIO (com bucket criado automaticamente), Redis e o binário `ffmpeg`/`ffprobe` no ambiente Docker — a fundação que todos os demais SIs consomem.

**Technical actions:**

1. Instalar em `nestjs-project` (dentro do container): `@nestjs/bullmq@^11.0.5`, `bullmq@^6.3.8`, `@aws-sdk/client-s3@^3.1137.0`, `@aws-sdk/s3-request-presigner@^3.1137.0`, `@aws-sdk/lib-storage@^3.1137.0`, `nanoid@^3.3.19` — versões CommonJS exigidas pelo runtime Jest/ts-jest (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`, `phase-03-videos/TD-07` revisions)
2. Adicionar `ffmpeg` ao `apt install` do `Dockerfile.dev` — a mesma imagem serve a API (testes de integração) e o worker (per `phase-03-videos/TD-06`, `phase-03-videos/TD-05`)
3. Adicionar ao `compose.yaml`: `redis` (`redis:7`, healthcheck `redis-cli ping`), `minio` (`minio/minio`, `server /data --console-address ":9001"`, portas `9000`/`9001`, volume nomeado, healthcheck em `/minio/health/live`) e `minio-init` (`minio/mc`, one-shot: `mc alias set` + `mc mb --ignore-existing` do bucket `streamtube`); `nestjs-api` passa a depender de `redis` (healthy) e `minio-init` (`service_completed_successfully`) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`, `phase-03-videos/TD-04`)
4. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` com `S3_ENDPOINT` (default `http://minio:9000`), `S3_PUBLIC_ENDPOINT` (default `http://localhost:9000`), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY`, `S3_SECRET_KEY` (obrigatórios), `S3_BUCKET` (default `streamtube`), `S3_UPLOAD_PART_URL_EXPIRES_SECONDS` (default `3600`), `S3_DOWNLOAD_URL_EXPIRES_SECONDS` (default `14400`); e `src/config/queue.config.ts` — `registerAs('queue', ...)` com `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`) (per `phase-03-videos/TD-10`, `phase-01-configuracao-base/TD-03`)
5. Estender `src/config/env.validation.ts` (Joi) e `.env.example` com as novas chaves — hosts pelo nome do serviço Compose; `S3_PUBLIC_ENDPOINT=http://localhost:9000` documentado como o host acessado pelo cliente (navegador), não um host container-a-container (per `phase-03-videos/TD-10`, `phase-01-configuracao-base/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: novas chaves obrigatórias rejeitam ausência; defaults aplicados | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `redis` e `minio` como healthy e `minio-init` termina com código 0
- Após o `minio-init`, o bucket `streamtube` existe no MinIO; reexecutar `minio-init` não falha
- `docker compose exec nestjs-api ffprobe -version` e `ffmpeg -version` retornam código 0
- A aplicação não inicia quando `S3_ACCESS_KEY` ou `S3_SECRET_KEY` estão ausentes
- Com apenas as chaves obrigatórias definidas, `storage` e `queue` resolvem os defaults documentados

---

### SI-03.2 — Módulo de storage S3/MinIO

**Description:** Encapsular todo acesso ao object storage em um `StorageModule` sem conhecimento do domínio de vídeos, com um cliente interno para operações do servidor e um cliente público usado apenas para assinar URLs.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.service.ts` — dois `S3Client` (`forcePathStyle: true`): um em `S3_ENDPOINT` para operações do servidor e outro em `S3_PUBLIC_ENDPOINT` usado só por `getSignedUrl`, com o bucket vindo de `storageConfig` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-10`)
2. Implementar em `StorageService`: `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber)`, `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)`, `headObject(key)`, `deleteObject(key)`, `putObject(key, body, contentType)` e `presignGetObject(key, { disposition?, audience: 'public' | 'internal' })`, sempre com `expiresIn` explícito vindo da config (per `phase-03-videos/TD-02`, `phase-03-videos/TD-08`, `phase-03-videos/TD-10`, `phase-03-videos/TD-11`, `phase-03-videos/TD-12`)
3. Traduzir as rejeições do `CompleteMultipartUpload` (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload`) em um erro próprio do módulo (`MultipartCompletionError`), para que o domínio de vídeos decida o código HTTP sem conhecer o SDK
4. Adicionar um arquivo de `setupFiles` do Jest (em `package.json` e `test/jest-e2e.json`) que, sob teste, define `S3_PUBLIC_ENDPOINT` igual a `S3_ENDPOINT` — as URLs pré-assinadas ficam alcançáveis de dentro do container (per `phase-03-videos/TD-10`)
5. Atualizar `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` — seção Object Storage passa a ser "Real (Docker MinIO)", no mesmo padrão de PostgreSQL/Mailpit (per `phase-03-videos/TD-03` revision)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real): multipart create → PUT pré-assinado por parte → complete → `headObject`; GET pré-assinado com `Range` retorna 206; abort; delete | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação do módulo com config de teste | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — MinIO, bucket e `storageConfig` precisam existir

**Acceptance criteria:**

- Um upload multipart com duas partes enviadas por URLs pré-assinadas e depois completado produz um objeto cujo `ContentLength` é a soma das partes
- Um GET pré-assinado com `Range: bytes=0-1023` retorna `206 Partial Content` com exatamente 1024 bytes
- Um GET pré-assinado com `disposition` retorna o header `Content-Disposition: attachment; filename="..."`
- Completar um upload com um `ETag` errado lança `MultipartCompletionError`, e o upload continua aberto
- Após `abortMultipartUpload`, completar o mesmo `uploadId` falha
- URLs geradas com `audience: 'public'` usam o host de `S3_PUBLIC_ENDPOINT`, e as de `audience: 'internal'` usam o de `S3_ENDPOINT`

---

### SI-03.3 — Entidade Video, migration e gerador de slug

**Description:** Criar a tabela `videos` ligada ao canal, com o ciclo de status e as colunas de storage e metadados, mais o gerador do identificador público curto.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `Video` com as colunas, o enum `VideoStatus` (`draft`, `processing`, `ready`, `error`), a relação `ManyToOne` → `Channel` e os índices exatamente como em `### Data Model → Video`; adicionar o lado inverso `OneToMany` `videos` em `Channel` (sem cascade) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-06`, `phase-03-videos/TD-07`, `phase-03-videos/TD-09`)
2. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate` e revisar: tipo enum `video_status`, tabela `videos`, FK para `channels(id)` `ON DELETE CASCADE`, índice único em `slug`, índices em `channel_id` e `(status, created_at)`; o `down` remove tabela e enum
3. Criar `src/videos/slug.util.ts` — `generateVideoSlug()` com `customAlphabet` do `nanoid` (import seguro, não `nanoid/non-secure`) sobre `[0-9A-Za-z]`, tamanho 11 (per `phase-03-videos/TD-07`)
4. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrá-lo no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: default `status = draft`; `slug` único; FK cascade ao remover o canal; `size_bytes` > 2^31 persiste; `metadata` jsonb | `src/videos/entities/video.entity.integration-spec.ts` |
| `generateVideoSlug` | Unit: tamanho 11, somente `[0-9A-Za-z]` | `src/videos/slug.util.spec.ts` |
| `CreateVideos` migration | Integration: o migration runner existente aplica e reverte todas as migrations, incluindo esta | teste de migrations existente da Fase 02 (SI-02.16) |

**Dependencies:** SI-03.1 — dependência `nanoid` instalada

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` e o tipo `video_status`, e `npm run migration:revert` remove os dois
- Um `Video` inserido sem `status` é persistido como `draft`
- Inserir dois vídeos com o mesmo `slug` falha com violação de unicidade
- Remover um canal remove os seus vídeos
- Um `size_bytes` de 10737418240 é persistido e lido de volta sem perda
- `generateVideoSlug()` retorna 11 caracteres de `[0-9A-Za-z]`

---

### SI-03.4 — Filas BullMQ e produtor do job de processamento

**Description:** Conectar a aplicação ao Redis via BullMQ, registrar as filas `video-processing` e `video-maintenance` e expor o produtor do job `process-video` com as opções de retry e idempotência decididas.

**Technical actions:**

1. Criar `src/queue/queue.constants.ts` — nomes das filas (`video-processing`, `video-maintenance`), dos jobs (`process-video`, `sweep-abandoned-uploads`) e do scheduler (`abandoned-upload-sweep`), conforme `### Events/Messages`
2. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync` lendo `queueConfig` via `ConfigType` + `BullModule.registerQueue` das duas filas, exportando-as (per `phase-03-videos/TD-01`, `phase-01-configuracao-base/TD-03`)
3. Criar `src/videos/video-processing.queue.ts` — `VideoProcessingQueue.enqueueProcessVideo(videoId)` com `@InjectQueue('video-processing')` e opções `jobId: videoId`, `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }` (per `phase-03-videos/TD-09` revision)
4. Importar `QueueModule` em `VideosModule` e registrar `VideoProcessingQueue` como provider

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingQueue` | Integration (Redis real): job criado com `jobId`, `attempts`, `backoff`; um segundo enqueue do mesmo `videoId` não cria outro job; a fila é limpa com `obliterate` no `beforeEach` | `src/videos/video-processing.queue.integration-spec.ts` |
| `QueueModule` | Unit: compilação do módulo com as duas filas registradas | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.1 — Redis e `queueConfig` precisam existir; SI-03.3 — `VideosModule` precisa existir

**Acceptance criteria:**

- `enqueueProcessVideo(id)` deixa na fila `video-processing` um job `process-video` com `data.videoId = id`, `opts.jobId = id` e `opts.attempts = 3`
- Chamar `enqueueProcessVideo(id)` duas vezes resulta em um único job
- A aplicação inicializa com o Redis disponível, e o `QueueModule` resolve as duas filas via injeção

---

### SI-03.5 — Endpoint POST /videos (pré-cadastro do rascunho e início do upload)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-initiate-upload.plan.md`
**Authorization:** Authenticated (per `### Authorization Matrix`)

**Description:** Ao iniciar o upload, pré-cadastrar o vídeo como `draft` no canal do usuário, abrir o upload multipart no storage e devolver as URLs pré-assinadas de cada parte — os bytes do arquivo nunca passam pela API.

**Technical actions:**

1. Adicionar `ChannelsService.findByUserId(userId)` ao `ChannelsModule` (dono da busca de canal) e importar `ChannelsModule` + `StorageModule` em `VideosModule`
2. Criar `src/videos/videos.exceptions.ts` — `VideoNotFoundException`, `VideoNotInDraftException`, `VideoNotReadyException`, `UploadPartsInvalidException` e `UploadSizeMismatchException` estendendo `DomainException`, com códigos, status e mensagens exatamente como em `### Error Catalog` (per `phase-02-auth/TD-07`)
3. Criar `src/videos/dto/initiate-upload.dto.ts` (validação per `### API Contracts → Validation Rules — Video Upload`) e o DTO de resposta de `### API Contracts → POST /videos`
4. Implementar `VideosService.initiateUpload(userId, dto)`: resolve o canal; gera `id` (`randomUUID`) e `slug` (`generateVideoSlug`, até 3 tentativas em violação de unicidade); `storage_key = videos/{id}/original.{mp4|webm}`; `title` padrão = `fileName` sem extensão; `part_size_bytes = 104857600` e `part_count = ceil(sizeBytes / part_size_bytes)`; `createMultipartUpload`, persistência com `upload_id` e `presignUploadPart` para cada parte; se a persistência falhar, `abortMultipartUpload` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`, `phase-03-videos/TD-07`, `phase-03-videos/TD-11`)
5. Criar `src/videos/videos.controller.ts` com `POST /videos` → `201`, `@SkipThrottle()` no controller (o `ThrottlerGuard` da Fase 02 é global, 10 req/min) e decorators OpenAPI `@ApiTags('videos')`, `@ApiBearerAuth()`, `@ApiOperation`, `@ApiResponse` por status (per `openapi-docs-nestjs/TD-01` revision)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: retry do slug em colisão; abort do multipart quando a persistência falha; `title` padrão; cálculo de `part_count` | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration (Postgres + MinIO reais): linha `draft` com `upload_id`, `storage_key` no layout `videos/{id}/original.{ext}` e uma URL por parte | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário; `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — `StorageService`; SI-03.3 — entidade `Video`, `VideosModule` e `generateVideoSlug`

**Acceptance criteria:**

- `POST /videos` autenticado com `{ fileName: "clip.mp4", mimeType: "video/mp4", sizeBytes: 209715200 }` retorna `201` com `status: "draft"`, `partSizeBytes: 104857600`, `partCount: 2` e `parts` com `partNumber` 1 e 2
- Após esse `201`, existe uma linha em `videos` com `status = draft`, `channel_id` do canal do usuário, `upload_id` não nulo e `title = "clip"`
- `PUT` do conteúdo da parte na `url` retornada é aceito pelo storage, sem passar pela API
- `POST /videos` com `mimeType: "video/x-msvideo"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` com `sizeBytes: 10737418241` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem access token retorna `401`
- Dois uploads iniciados pelo mesmo usuário recebem `slug`s distintos

---

### SI-03.6 — Endpoint POST /videos/:slug/upload/part-urls (retomada do upload)

**Route:** POST /videos/:slug/upload/part-urls
**Test Specs:** see `nestjs-project/specs/videos-upload-part-urls.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Permitir que o cliente retome um upload interrompido pedindo novas URLs pré-assinadas só para as partes que faltam, sem reiniciar a transferência.

**Technical actions:**

1. Implementar `VideosService.findOwnedBySlug(userId, slug)` — `slug` fora do formato de 11 caracteres `[0-9A-Za-z]`, inexistente ou de outro canal → `VideoNotFoundException`. É o guarda de posse reutilizado por todos os endpoints `/videos/:slug*` (per `phase-03-videos/TD-08` revision)
2. Criar `src/videos/dto/request-part-urls.dto.ts` — `partNumbers`: `ArrayNotEmpty`, `ArrayUnique`, `ArrayMaxSize(10000)`, `IsInt` e `Min(1)` em cada item
3. Implementar `VideosService.reissuePartUrls(userId, slug, dto)`: `status != draft` → `VideoNotInDraftException`; algum `partNumber > part_count` → exceção de domínio `400 VALIDATION_ERROR`; senão `presignUploadPart` para cada parte com `partUrlsExpireAt` (per `phase-03-videos/TD-10`)
4. Adicionar `POST /videos/:slug/upload/part-urls` → `200` ao `VideosController`, com os decorators OpenAPI de cada status

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findOwnedBySlug` / `reissuePartUrls` | Unit: slug malformado → 404; canal diferente → 404; não-`draft` → 409; parte fora de `1..part_count` → 400 | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.5 — vídeo `draft` com upload aberto e `VideosController`

**Acceptance criteria:**

- `POST /videos/{slug}/upload/part-urls` com `{ partNumbers: [2] }` para um rascunho próprio retorna `200` com uma única entrada em `parts`, de `partNumber: 2`
- A `url` reemitida aceita o `PUT` da parte, e o `ETag` resultante é aceito depois no complete
- `partNumbers: [3]` para um vídeo com `partCount: 2` retorna `400` com `error: "VALIDATION_ERROR"`
- `partNumbers: []` retorna `400` com `error: "VALIDATION_ERROR"`
- O mesmo request feito por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`
- Para um vídeo em `processing`, o request retorna `409` com `error: "VIDEO_NOT_IN_DRAFT"`

---

### SI-03.7 — Endpoint POST /videos/:slug/upload/complete (conclusão e enfileiramento)

**Route:** POST /videos/:slug/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Concluir o upload multipart, verificar o tamanho armazenado, mover o vídeo para `processing` e enfileirar o processamento automático — ou rejeitar o upload deixando o motivo registrado.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` — `parts` com `ValidateNested` + `Type`, `ArrayNotEmpty`, `partNumber` `IsInt` `Min(1)`, `etag` `IsString` `IsNotEmpty`
2. Implementar `VideosService.completeUpload(userId, slug, dto)`: posse via `findOwnedBySlug`; `status != draft` → `VideoNotInDraftException`; o conjunto de `partNumber` precisa ser exatamente `1..part_count` (senão exceção de domínio `400 VALIDATION_ERROR`); `completeMultipartUpload`, com `MultipartCompletionError` → `UploadPartsInvalidException` e o vídeo permanecendo `draft` (per `phase-03-videos/TD-02`)
3. Após o complete, `headObject(storage_key)`: `ContentLength > 10737418240` ou diferente de `size_bytes` → `deleteObject`, `status = error`, `processing_error = 'UPLOAD_SIZE_MISMATCH: declared {n} bytes, stored {m} bytes'`, `upload_id = null` e `UploadSizeMismatchException` (per `phase-03-videos/TD-11` revision)
4. No caminho feliz: atualizar `status = processing`, `uploaded_at = now()` e `upload_id = null`, e então `VideoProcessingQueue.enqueueProcessVideo(id)`; se o enqueue falhar, reverter para `draft` com o `upload_id` original e relançar o erro (per `phase-03-videos/TD-09` revision)
5. Adicionar `POST /videos/:slug/upload/complete` → `202` ao `VideosController`, com os decorators OpenAPI de cada status

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: não-`draft` → 409; conjunto de partes incompleto → 400; `MultipartCompletionError` → 422 mantendo `draft`; tamanho divergente → delete + `error` + 422; falha no enqueue reverte para `draft` | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (Postgres + MinIO + Redis reais): upload real de 2 partes → `processing`, `uploaded_at` preenchido e job `process-video` com `jobId` = id do vídeo | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4 — `VideoProcessingQueue`; SI-03.6 — `findOwnedBySlug`

**Acceptance criteria:**

- `POST /videos/{slug}/upload/complete` com os `ETag`s de todas as partes retorna `202` com `status: "processing"`, e o vídeo fica com `status = processing` e `uploaded_at` preenchido
- O mesmo complete deixa na fila `video-processing` um job `process-video` com `jobId` igual ao `id` do vídeo
- Repetir o complete retorna `409` com `error: "VIDEO_NOT_IN_DRAFT"` e não cria um segundo job
- Um complete com um `etag` inválido retorna `422` com `error: "UPLOAD_PARTS_INVALID"`, e o vídeo continua `draft`
- Um upload cujo tamanho armazenado difere do `sizeBytes` declarado retorna `422` com `error: "UPLOAD_SIZE_MISMATCH"`; o objeto deixa de existir no storage e o vídeo fica `error` com `processing_error` iniciando por `UPLOAD_SIZE_MISMATCH`
- Um complete que não cobre todas as partes de `1..partCount` retorna `400` com `error: "VALIDATION_ERROR"`

---

### SI-03.8 — Serviço de mídia: ffprobe e extração de frame via child_process

**Description:** Isolar o uso dos binários `ffprobe`/`ffmpeg` em um `MediaModule` que extrai duração/metadados e gera a thumbnail a partir de um frame, sem expor a CLI a quem o chama.

**Technical actions:**

1. Criar `src/media/media.module.ts` e `src/media/media-probe.service.ts` — `probe(input)` executa `ffprobe -v error -print_format json -show_format -show_streams <input>` via `spawn` com argumentos em array (sem shell, sem interpolação de strings) e timeout; aceita caminho local ou URL HTTP (per `phase-03-videos/TD-06`)
2. Implementar `parseProbeOutput(json)` como função pura → `{ durationSeconds, width, height, formatName, hasVideoStream, metadata }`, onde `metadata` reúne codecs de vídeo/áudio, bitrate, `format_name` e frame rate — os mesmos campos do `### Data Model → Video` (per `phase-03-videos/TD-06` revision)
3. Implementar `extractFrame(input, atSeconds, outputPath)` — `ffmpeg -ss <t> -i <input> -frames:v 1 -q:v 2 -y <outputPath>` via `spawn`; código de saída ≠ 0 rejeita com a cauda do `stderr` na mensagem (per `phase-03-videos/TD-06`)
4. Criar `test/fixtures/sample-video.ts` — gera em tempo de teste um MP4 curto (`ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=25` + faixa de áudio `sine`) em diretório temporário; nenhum binário de vídeo entra no repositório

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseProbeOutput` | Unit: mapeia `format.duration`, primeiro stream de vídeo (width/height/codec), stream de áudio opcional; sem stream de vídeo → `hasVideoStream: false` | `src/media/media-probe.service.spec.ts` |
| `MediaProbeService` | Integration (ffprobe/ffmpeg reais no container): `probe` do fixture MP4; `extractFrame` gera um JPEG não vazio; `probe` de um arquivo de texto rejeita | `src/media/media-probe.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — `ffmpeg`/`ffprobe` instalados na imagem

**Acceptance criteria:**

- `probe` do fixture de 2s em 320x240 retorna `durationSeconds` ≈ 2 (±0.1), `width: 320`, `height: 240` e `hasVideoStream: true`
- `probe` de um arquivo que não é mídia rejeita com erro contendo a saída do `ffprobe`
- `extractFrame(fixture, 1, out.jpg)` cria `out.jpg` com tamanho > 0 bytes
- Um caminho de entrada com espaços ou `;` é tratado como um único argumento, sem execução de shell

---

### SI-03.9 — Worker de vídeo: entrypoint standalone e processamento do job

**Description:** Subir o Video Worker como container separado — uma aplicação Nest sem listener HTTP, reaproveitando o mesmo código — que consome `process-video`, extrai os metadados, gera a thumbnail e registra o resultado no ciclo de status.

**Technical actions:**

1. Criar `src/video-processing/video-processing.service.ts` — `process(videoId)`:
   - se o vídeo já está `ready`, retorna (idempotência);
   - `probe` de um GET pré-assinado **interno** do `storage_key` (sem cópia local do original);
   - rejeita com `UnrecoverableError('UNSUPPORTED_MEDIA: ...')` se não houver stream de vídeo ou o container não for `mp4`/`webm`;
   - `extractFrame` em 10% da duração para arquivo temporário e `putObject` em `videos/{id}/thumbnail.jpg`;
   - grava `duration_seconds`, `width`, `height`, `metadata`, `thumbnail_key` e `status = ready` em um único update, e remove o temporário.

   (per `phase-03-videos/TD-04`, `phase-03-videos/TD-06`, `phase-03-videos/TD-09`)
2. Criar `src/video-processing/video-processing.processor.ts` — `@Processor('video-processing')` estendendo `WorkerHost`, delegando ao serviço; `@OnWorkerEvent('failed')` grava `status = error` + `processing_error` somente quando `job.attemptsMade >= job.opts.attempts` ou o erro é `UnrecoverableError` (`UNSUPPORTED_MEDIA: ...` / `PROCESSING_FAILED: ...`) (per `phase-03-videos/TD-09` revision)
3. Criar `src/video-processing/video-processing.module.ts` e `src/worker/worker.module.ts` — `ConfigModule` (mesma validação Joi), `TypeOrmModule.forRootAsync` via `databaseConfig` (sem duplicar parâmetros), `QueueModule`, `StorageModule`, `MediaModule` e `VideoProcessingModule`; sem `MailerModule`, sem controllers (per `phase-03-videos/TD-05`, `phase-01-configuracao-base/TD-04`)
4. Criar `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()`; scripts `start:worker` (`node dist/worker`) e `start:worker:dev` (`nest start --watch --entryFile worker`) (per `phase-03-videos/TD-05`)
5. Adicionar o serviço `video-worker` ao `compose.yaml` — mesmo `Dockerfile.dev` e volume do `nestjs-api`, comando `npm run start:worker:dev`, `depends_on` de `db` (healthy), `redis` (healthy) e `minio-init` (completed) (per `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Integration (Postgres + MinIO + ffmpeg reais): fixture enviado ao MinIO → `ready` com duração/dimensões/metadata e objeto `thumbnail.jpg` existente; vídeo já `ready` não é reprocessado; arquivo não-vídeo → `UnrecoverableError` | `src/video-processing/video-processing.service.integration-spec.ts` |
| `VideoProcessingProcessor` | Unit: `failed` antes da última tentativa não escreve; na última tentativa escreve `PROCESSING_FAILED`; `UnrecoverableError` escreve `UNSUPPORTED_MEDIA` na primeira falha | `src/video-processing/video-processing.processor.spec.ts` |
| `WorkerModule` | Unit: compilação do módulo sem HTTP e sem `MailerModule` | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.2 — `StorageService`; SI-03.3 — entidade `Video`; SI-03.4 — filas; SI-03.8 — `MediaProbeService`

**Acceptance criteria:**

- `docker compose up -d` sobe `video-worker` sem abrir porta HTTP, e ele permanece em execução
- Um job `process-video` para um vídeo `processing` com MP4 válido termina com `status = ready`, `duration_seconds`, `width`, `height` e `metadata` preenchidos, e com o objeto `videos/{id}/thumbnail.jpg` presente no storage
- Um job para um objeto que não é vídeo termina com `status = error` e `processing_error` iniciando por `UNSUPPORTED_MEDIA` após uma única tentativa
- Um erro transitório que se repete nas 3 tentativas termina com `status = error` e `processing_error` iniciando por `PROCESSING_FAILED`; nas tentativas 1 e 2 o status permanece `processing`
- Reentregar o job de um vídeo já `ready` não altera a linha nem regrava a thumbnail

---

### SI-03.10 — Endpoint GET /videos/:slug (detalhe e status do vídeo)

**Route:** GET /videos/:slug
**Test Specs:** see `nestjs-project/specs/videos-detail.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Expor ao dono o estado do vídeo — status do ciclo, metadados extraídos, thumbnail e motivo de falha — para que o resultado do processamento seja observável pela API.

**Technical actions:**

1. Criar `src/videos/dto/video-response.dto.ts` — campos exatamente como em `### API Contracts → GET /videos/:slug`; `sizeBytes` convertido de `bigint` (string no TypeORM) para `number`; `durationSeconds` de `numeric` para `number`
2. Implementar `VideosService.getOwnedVideo(userId, slug)` — posse via `findOwnedBySlug`; `thumbnailUrl` = `presignGetObject(thumbnail_key, { audience: 'public' })` quando `thumbnail_key` existe, senão `null` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-10`)
3. Adicionar `GET /videos/:slug` → `200` ao `VideosController`, com decorators OpenAPI (`@ApiOkResponse` com o DTO, `@ApiResponse` 404)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getOwnedVideo` | Unit: `thumbnailUrl` nulo sem `thumbnail_key`; conversão de `size_bytes`/`duration_seconds`; outro canal → 404 | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.6 — `findOwnedBySlug`

**Acceptance criteria:**

- `GET /videos/{slug}` de um rascunho recém-criado retorna `200` com `status: "draft"`, `durationSeconds: null` e `thumbnailUrl: null`
- Após o processamento, `GET /videos/{slug}` retorna `status: "ready"`, `durationSeconds`, `width` e `height` numéricos e `thumbnailUrl` cujo GET retorna uma imagem JPEG
- Para um vídeo em `error`, `GET /videos/{slug}` retorna `processingError` com o motivo registrado
- `sizeBytes` é retornado como número JSON, inclusive para valores acima de 2^31
- `GET /videos/{slug}` feito por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.11 — Endpoints GET /videos/:slug/stream e /download (streaming e download)

**Route:** GET /videos/:slug/stream, GET /videos/:slug/download
**Test Specs:** see `nestjs-project/specs/videos-delivery.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Entregar reprodução por streaming e download direto do storage via URLs pré-assinadas — a API só assina, os bytes nunca passam por ela, e o `Range`/`206` vem do próprio storage.

**Technical actions:**

1. Implementar `VideosService.getDeliveryUrl(userId, slug, mode: 'stream' | 'download')` — posse via `findOwnedBySlug`; `status != ready` → `VideoNotReadyException`; `presignGetObject(storage_key, { audience: 'public' })`, com `disposition: attachment; filename="{original_file_name}"` (aspas e caracteres de controle escapados) quando `mode = download`; `expiresAt = now + S3_DOWNLOAD_URL_EXPIRES_SECONDS` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-10`)
2. Criar o DTO de resposta `{ url, expiresAt }` e adicionar `GET /videos/:slug/stream` e `GET /videos/:slug/download` → `200` ao `VideosController`, com decorators OpenAPI (`@ApiOkResponse`, `@ApiResponse` 404/409)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getDeliveryUrl` | Unit: não-`ready` → 409; `download` inclui `ResponseContentDisposition` com o nome escapado; `stream` não inclui; outro canal → 404 | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.10 — vídeo `ready` observável e padrão de resposta com URL pré-assinada

**Acceptance criteria:**

- `GET /videos/{slug}/stream` de um vídeo `ready` retorna `200` com `url` e `expiresAt` cerca de 4h no futuro
- Um GET na `url` de stream com `Range: bytes=0-1023` retorna `206 Partial Content` com `Content-Range: bytes 0-1023/{size}` e 1024 bytes de corpo (per `phase-03-videos/TD-08` revision)
- Um GET na `url` de download retorna `200` com `Content-Disposition: attachment; filename="{original_file_name}"` e o arquivo completo
- `GET /videos/{slug}/stream` ou `/download` de um vídeo em `processing` retorna `409` com `error: "VIDEO_NOT_READY"`
- `GET /videos/{slug}/stream` feito por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.12 — Varredura de uploads abandonados

**Description:** Limpar periodicamente os rascunhos cujo upload nunca foi concluído — abortando as partes no storage e registrando o abandono no vídeo — para que uploads interrompidos não acumulem custo de armazenamento.

**Technical actions:**

1. Criar `src/video-processing/video-maintenance.service.ts` — `sweepAbandonedUploads(now)`: seleciona `status = draft`, `upload_id IS NOT NULL` e `created_at < now - 24h`; para cada vídeo, `abortMultipartUpload` (tratando `NoSuchUpload` como já abortado) e depois `upload_id = null`, `status = error` e `processing_error = 'UPLOAD_ABANDONED'`. Um item que falha não interrompe os demais (per `phase-03-videos/TD-12` revision)
2. Criar `src/video-processing/video-maintenance.processor.ts` — `@Processor('video-maintenance')` estendendo `WorkerHost` e delegando ao serviço; em `onApplicationBootstrap`, `upsertJobScheduler('abandoned-upload-sweep', { every: 3600000 }, { name: 'sweep-abandoned-uploads', data: {} })` na fila injetada (per `phase-03-videos/TD-12`)
3. Registrar serviço e processor no `VideoProcessingModule` (carregado apenas pelo `WorkerModule`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoMaintenanceService` | Integration (Postgres + MinIO reais): rascunho com multipart aberto real e `created_at` de 25h atrás → abortado e `error`/`UPLOAD_ABANDONED`; rascunho de 1h intocado; vídeo `ready` antigo intocado; `upload_id` já abortado no storage não quebra a varredura | `src/video-processing/video-maintenance.service.integration-spec.ts` |
| `VideoMaintenanceProcessor` | Unit: registra o scheduler `abandoned-upload-sweep` com `every: 3600000` no bootstrap; `process` delega ao serviço | `src/video-processing/video-maintenance.processor.spec.ts` |

**Dependencies:** SI-03.9 — `VideoProcessingModule` e `WorkerModule`

**Acceptance criteria:**

- Após uma varredura, um rascunho criado há mais de 24h com upload aberto fica com `status = error`, `processing_error = 'UPLOAD_ABANDONED'` e `upload_id = null`
- Após essa varredura, completar o `upload_id` antigo no storage falha, porque o multipart foi abortado
- Rascunhos com menos de 24h e vídeos fora de `draft` não são alterados pela varredura
- Após o boot do `video-worker`, a fila `video-maintenance` tem exatamente um job scheduler `abandoned-upload-sweep`, mesmo após reinícios

---

### SI-03.13 — Documentação OpenAPI dos endpoints de vídeo

**Description:** Garantir que os seis endpoints de vídeo aparecem no spec OpenAPI com operações, schemas por status e o envelope de erro de domínio, e regenerar o `openapi.json` versionado.

**Technical actions:**

1. Revisar o `VideosController` e os DTOs de vídeo — todo endpoint com `@ApiOperation`, `@ApiParam('slug')` onde aplicável e `@ApiResponse` para cada status de `### API Contracts`, incluindo os códigos de `### Error Catalog` com o schema do envelope `{ statusCode, error, message }` (per `openapi-docs-nestjs/TD-01` revision, `phase-02-auth/TD-07`)
2. Regenerar `nestjs-project/openapi.json` com `npm run openapi:export` e versionar o arquivo atualizado (per `openapi-docs-nestjs/TD-02`)
3. Estender `test/swagger.e2e-spec.ts` — o documento contém os 6 paths de vídeo com os métodos corretos e o esquema de segurança bearer

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Spec OpenAPI | E2E: `GET /api/docs-json` lista `/videos`, `/videos/{slug}`, `/videos/{slug}/upload/part-urls`, `/videos/{slug}/upload/complete`, `/videos/{slug}/stream` e `/videos/{slug}/download` | `test/swagger.e2e-spec.ts` |

**Dependencies:** SI-03.5, SI-03.6, SI-03.7, SI-03.10, SI-03.11 — todos os endpoints precisam existir

**Acceptance criteria:**

- O documento OpenAPI contém os 6 paths de vídeo, cada um com `security` bearer
- `POST /videos/{slug}/upload/complete` documenta as respostas `202`, `400`, `404`, `409` e `422`
- O `openapi.json` versionado é idêntico ao gerado por `npm run openapi:export`
- Com `SWAGGER_ENABLED=false`, a UI do Swagger continua indisponível (política herdada da Fase 02, per `openapi-docs-nestjs/TD-03`)

---

### SI-03.14 — Teste ponta a ponta do pipeline (upload → worker → streaming)

**Description:** Provar o fluxo completo com a infraestrutura real do Compose: upload multipart direto ao MinIO, conclusão, processamento pelo container `video-worker`, e streaming/download do vídeo pronto.

**Technical actions:**

1. Criar `test/helpers/authenticated-user.ts` — registra, confirma (link via Mailpit, padrão do `auth.e2e-spec.ts`) e autentica um usuário, retornando o `access_token`
2. Criar `test/videos-pipeline.e2e-spec.ts`, que:
   - gera o fixture MP4 (`test/fixtures/sample-video.ts`) e chama `POST /videos`;
   - faz `PUT` de cada parte na URL pré-assinada e `POST /upload/complete` com os `ETag`s;
   - faz polling de `GET /videos/:slug` (intervalo 1s, limite 60s) até `ready` — processado pelo `video-worker` real, não por chamada direta ao serviço;
   - valida os metadados e a thumbnail, e depois o `stream` com `Range` → 206 e o `download` → `Content-Disposition: attachment`.
3. Configurar timeout de 90s para esse spec e documentar no cabeçalho do arquivo que ele exige `video-worker` em execução (`docker compose up -d`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Pipeline de vídeo | E2E (API + MinIO + Redis + `video-worker` reais) | `test/videos-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.7 — conclusão e enfileiramento; SI-03.9 — `video-worker` em execução; SI-03.11 — URLs de stream/download

**Acceptance criteria:**

- Um MP4 de 2s enviado via URLs pré-assinadas e concluído chega a `status: "ready"` em até 60s, sem nenhuma chamada direta ao serviço de processamento
- O vídeo pronto expõe `durationSeconds` ≈ 2, `width: 320`, `height: 240` e `thumbnailUrl` cujo GET retorna `Content-Type: image/jpeg`
- O GET com `Range: bytes=0-1023` na `url` de stream retorna `206` com 1024 bytes
- O download retorna o arquivo completo, com o mesmo tamanho declarado em `sizeBytes`

---

### SI-03.15 — Documentação: CLAUDE.md e diagrama de arquitetura

**Description:** Atualizar a documentação de IA e o diagrama para refletir o estado real do código: módulo de vídeos, endpoints, fila/worker e storage.

**Technical actions:**

1. Atualizar `nestjs-project/CLAUDE.md`:
   - serviços `minio`, `minio-init`, `redis` e `video-worker`;
   - verificações de prontidão (`redis-cli ping`, MinIO `/minio/health/live`);
   - comandos do worker (`start:worker`, `start:worker:dev`, `docker compose logs video-worker`);
   - `ffmpeg` na imagem e testes contra MinIO/Redis reais;
   - a exceção documentada de `S3_PUBLIC_ENDPOINT=http://localhost:9000` (host do cliente/navegador, não container-a-container) (per `phase-03-videos/TD-10`).
2. Atualizar o `CLAUDE.md` da raiz com a seção de vídeos:
   - os 6 endpoints e o ciclo `draft → processing → ready | error`;
   - upload multipart pré-assinado direto ao storage;
   - fila BullMQ/Redis (substituindo "TBD" na seção de arquitetura);
   - o worker standalone e as chaves `videos/{id}/...` no bucket `streamtube`.
3. Atualizar `docs/diagrams/software-arch.mermaid` — `Message Queue` de `"TBD"` para `"BullMQ (Redis)"`, e a relação cliente → storage também para upload

**Tests:** _(empty — documentation only; accuracy is checked against the code in the Deliverables review)_

**Dependencies:** SI-03.12, SI-03.13, SI-03.14 — a documentação descreve o estado final

**Acceptance criteria:**

- Todo arquivo, script npm, serviço Compose e endpoint citado nos `CLAUDE.md` existe no repositório com o nome exato citado
- O `CLAUDE.md` da raiz não descreve mais a fila como "TBD"
- `docs/diagrams/software-arch.mermaid` nomeia a fila como BullMQ (Redis)

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier; FK target. Existing UUID-PK convention (per `phase-03-videos/TD-07`) |
| channel_id | uuid | FK → channels.id, not null, `ON DELETE CASCADE` | Owning channel (Phase 02: one channel per user) |
| slug | varchar(11) | unique, not null | Public short identifier — `nanoid` `customAlphabet` over `[0-9A-Za-z]`, length 11 (per `phase-03-videos/TD-07`); unique constraint + retry on conflict |
| title | varchar(100) | not null | From the initiation request; defaults to the original file name without extension |
| status | enum `video_status` (`draft`, `processing`, `ready`, `error`) | not null, default `draft` | Lifecycle per `phase-03-videos/TD-09` |
| original_file_name | varchar(255) | not null | Declared by the client at initiation |
| mime_type | varchar(50) | not null | Declared at initiation (allowlist `video/mp4`, `video/webm` per `phase-03-videos/TD-11`); typed metadata column per `phase-03-videos/TD-06` revision |
| size_bytes | bigint | not null | Declared at initiation; verified by `HeadObject` on completion (per `phase-03-videos/TD-11`). TypeORM maps `bigint` to `string` — convert at the service boundary |
| storage_key | varchar(512) | not null | `videos/{id}/original.{ext}` (per `phase-03-videos/TD-04`) |
| thumbnail_key | varchar(512) | nullable | `videos/{id}/thumbnail.jpg` (per `phase-03-videos/TD-04`); set by the worker |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId` while the upload is open (per `phase-03-videos/TD-02`); cleared on completion, rejection or abort |
| part_size_bytes | integer | not null | Server-fixed part size returned at initiation — 104857600 (100 MiB) (per `phase-03-videos/TD-11`) |
| part_count | integer | not null | `ceil(size_bytes / part_size_bytes)`; bounds the valid part numbers |
| uploaded_at | timestamp | nullable | Set when the multipart upload is completed and verified |
| duration_seconds | numeric(10,3) | nullable | From ffprobe `format.duration` (per `phase-03-videos/TD-06` revision) |
| width | integer | nullable | From the first video stream (per `phase-03-videos/TD-06` revision) |
| height | integer | nullable | From the first video stream (per `phase-03-videos/TD-06` revision) |
| metadata | jsonb | nullable | Remaining ffprobe fields: video/audio codecs, bitrate, container format, frame rate (per `phase-03-videos/TD-06` revision) |
| processing_error | text | nullable | Failure reason written with `status = error` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-11`, `phase-03-videos/TD-12` revisions) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn`; also the upload start time used by the abandonment sweep (per `phase-03-videos/TD-12`) |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one via `channel_id`); Channel → Video (one-to-many, inverse side only — no cascade on save)
**Indexes:** `(slug)` — unique; `(channel_id)`; `(status, created_at)` — supports the abandoned-upload sweep query

**Status transitions** (per `phase-03-videos/TD-09`, `phase-03-videos/TD-11`, `phase-03-videos/TD-12`):

| From | To | Trigger |
|------|----|---------|
| — | `draft` | `POST /videos` — upload initiated (pre-registration) |
| `draft` | `processing` | `POST /videos/:slug/upload/complete` — multipart completed and `HeadObject` size check passed; `process-video` job enqueued |
| `draft` | `error` | Completion rejected by the `HeadObject` check (`processing_error` = size rejection), OR abandoned-upload sweep after 24h (`processing_error` = upload abandoned) |
| `processing` | `ready` | Worker persisted metadata and thumbnail |
| `processing` | `error` | Final processing attempt failed (`job.attemptsMade >= job.opts.attempts`) or `UnrecoverableError` (unsupported container/codec) |

### API Contracts

All endpoints require a valid access token (global `JwtAuthGuard` from Phase 02) and act only on videos owned by the caller's channel (per `phase-03-videos/TD-08` revision). Video routes are keyed by the public `slug` (per `phase-03-videos/TD-07`). Presigned URLs are signed with the **public** storage endpoint client (per `phase-03-videos/TD-10`). File bytes never pass through the API (per `phase-03-videos/TD-02`).

#### POST /videos (SI-03.5)

Initiates an upload: pre-registers the video as `draft`, opens an S3 multipart upload, and returns one presigned `UploadPart` URL per part (per `phase-03-videos/TD-02`, `phase-03-videos/TD-11`).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- fileName: string, required — 1–255 characters
- mimeType: string, required — one of `video/mp4`, `video/webm`
- sizeBytes: integer, required — 1 to 10737418240 (10 GiB)
- title: string, optional — 1–100 characters; defaults to `fileName` without extension

**Response 201:**
- id: string (uuid)
- slug: string
- title: string
- status: `"draft"`
- partSizeBytes: number — 104857600
- partCount: number
- parts: array of `{ partNumber: number, url: string }` — one presigned `UploadPart` URL per part, in ascending `partNumber`
- partUrlsExpireAt: string (ISO-8601) — now + upload part URL lifetime (per `phase-03-videos/TD-10`)

**Error responses:**
- 400 VALIDATION_ERROR: when the request body fails schema validation (unsupported `mimeType`, `sizeBytes` out of range, missing `fileName`)
- 401 Unauthorized: when the access token is missing or invalid — framework `UnauthorizedException` thrown by the Phase 02 `JwtAuthGuard` (applies to every endpoint below; not repeated per endpoint)

---

#### POST /videos/:slug/upload/part-urls (SI-03.6)

Re-issues presigned `UploadPart` URLs for a still-open upload — the resume path after a dropped connection or URL expiry (per `phase-03-videos/TD-10` revision, `phase-03-videos/TD-12` revision).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- partNumbers: integer[], required — 1–10000 unique items, each between 1 and the video's `partCount`

**Response 200:**
- parts: array of `{ partNumber: number, url: string }`
- partUrlsExpireAt: string (ISO-8601)

**Error responses:**
- 400 VALIDATION_ERROR: when `partNumbers` is empty, has duplicates, or contains a number outside `1..partCount`
- 404 VIDEO_NOT_FOUND: when no video with `slug` exists in the caller's channel
- 409 VIDEO_NOT_IN_DRAFT: when the video's status is not `draft` (upload already completed, rejected or abandoned)

---

#### POST /videos/:slug/upload/complete (SI-03.7)

Completes the multipart upload, verifies the stored size, moves the video to `processing` and enqueues `process-video` (per `phase-03-videos/TD-09` revision, `phase-03-videos/TD-11` revision).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- parts: array, required — exactly `partCount` items, unique `partNumber`
  - partNumber: integer, required — 1..`partCount`
  - etag: string, required — the `ETag` header returned by storage for that part

**Response 202:**
- id: string (uuid)
- slug: string
- status: `"processing"`

**Error responses:**
- 400 VALIDATION_ERROR: when `parts` is missing, malformed, or does not cover `1..partCount` exactly
- 404 VIDEO_NOT_FOUND: when no video with `slug` exists in the caller's channel
- 409 VIDEO_NOT_IN_DRAFT: when the video's status is not `draft` — includes a repeated complete call (per `phase-03-videos/TD-09` revision)
- 422 UPLOAD_PARTS_INVALID: when storage rejects `CompleteMultipartUpload` (missing part, wrong `ETag`, part too small); the video stays `draft` so the client can re-upload the offending parts
- 422 UPLOAD_SIZE_MISMATCH: when the completed object's `ContentLength` exceeds 10737418240 or differs from the declared `sizeBytes`; the object is deleted and the video moves to `error` (per `phase-03-videos/TD-11` revision)

---

#### GET /videos/:slug (SI-03.10)

Returns the video and its processing state, so the owner can observe the status cycle.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- id: string (uuid)
- slug: string
- title: string
- status: `"draft"` | `"processing"` | `"ready"` | `"error"`
- mimeType: string
- sizeBytes: number
- durationSeconds: number | null
- width: number | null
- height: number | null
- metadata: object | null — ffprobe-derived codecs, bitrate, container format, frame rate
- thumbnailUrl: string | null — presigned GET URL for `thumbnail_key` (GET URL lifetime per `phase-03-videos/TD-10`); `null` until the thumbnail exists
- processingError: string | null
- createdAt: string (ISO-8601)
- updatedAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `slug` exists in the caller's channel

---

#### GET /videos/:slug/stream (SI-03.11)

Issues a presigned GET URL for inline playback. The client (`<video>` element) requests it directly from storage; HTTP `Range` requests are answered by storage with `206 Partial Content` (per `phase-03-videos/TD-08` — proven by an e2e test per its revision).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- url: string — presigned `GetObject` URL for `storage_key`
- expiresAt: string (ISO-8601) — now + GET URL lifetime (per `phase-03-videos/TD-10`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `slug` exists in the caller's channel
- 409 VIDEO_NOT_READY: when the video's status is not `ready` (per `phase-03-videos/TD-08` revision)

---

#### GET /videos/:slug/download (SI-03.11)

Issues a presigned GET URL that forces a file download (per `phase-03-videos/TD-08`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- url: string — presigned `GetObject` URL with `ResponseContentDisposition: attachment; filename="{original_file_name}"`
- expiresAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `slug` exists in the caller's channel
- 409 VIDEO_NOT_READY: when the video's status is not `ready`

---

#### Validation Rules — Video Upload

- `fileName`: required, string, 1–255 characters
- `mimeType`: required, one of `video/mp4`, `video/webm` (per `phase-03-videos/TD-11`)
- `sizeBytes`: required, integer, 1 to 10737418240 (per `phase-03-videos/TD-11`)
- `title`: optional, string, 1–100 characters (trimmed)
- `partNumbers`: required, non-empty array of unique integers, 1–10000 items; range against `partCount` is checked by the service
- `parts[].partNumber`: required, integer ≥ 1; the set must equal `1..partCount` (checked by the service)
- `parts[].etag`: required, non-empty string
- `:slug` path parameter: 11 characters from `[0-9A-Za-z]`; anything else is treated as `VIDEO_NOT_FOUND`

### Authorization Matrix

| Endpoint | Anonymous | Authenticated (non-owner) | Owner | Notes |
|----------|-----------|---------------------------|-------|-------|
| POST /videos | ✗ | ✓ | — | Creates the video in the caller's own channel |
| POST /videos/:slug/upload/part-urls | ✗ | ✗ (404) | ✓ | Non-owner receives `VIDEO_NOT_FOUND` — existence is not disclosed |
| POST /videos/:slug/upload/complete | ✗ | ✗ (404) | ✓ | |
| GET /videos/:slug | ✗ | ✗ (404) | ✓ | |
| GET /videos/:slug/stream | ✗ | ✗ (404) | ✓ | Owner-only in Phase 03 (per `phase-03-videos/TD-08` revision); public/anonymous access arrives with Phases 04/05 |
| GET /videos/:slug/download | ✗ | ✗ (404) | ✓ | Same rule as streaming |

Ownership = the video's `channel_id` equals the channel whose `user_id` is the access token's `sub`. Presigned URLs themselves are bearer-style: anyone holding a URL can use it until it expires (per `phase-03-videos/TD-08`, `phase-03-videos/TD-10`).

### Error Catalog

**Error response format:** inherited from Phase 02 — `{ statusCode, error, message }`, with `error` carrying the domain error code (per `phase-02-auth/TD-07`). New codes are `DomainException` subclasses mapped by the existing domain exception filter.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Any `/videos/:slug*` endpoint when the slug does not exist or the video belongs to another channel |
| VIDEO_NOT_IN_DRAFT | 409 | Video upload is no longer open | `POST /videos/:slug/upload/part-urls` or `/upload/complete` when `status != draft` (per `phase-03-videos/TD-09` revision) |
| VIDEO_NOT_READY | 409 | Video is not ready | `GET /videos/:slug/stream` or `/download` when `status != ready` (per `phase-03-videos/TD-08` revision) |
| UPLOAD_PARTS_INVALID | 422 | Uploaded parts are invalid or incomplete | `POST /videos/:slug/upload/complete` when storage rejects `CompleteMultipartUpload` (e.g. `InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`) |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded file size is invalid | `POST /videos/:slug/upload/complete` when `HeadObject.ContentLength` exceeds 10737418240 or differs from the declared `sizeBytes` (per `phase-03-videos/TD-11` revision) |

`processing_error` values written by the system (not HTTP errors — persisted on the video):

| Value | Written by | When |
|-------|-----------|------|
| `UPLOAD_SIZE_MISMATCH: declared {n} bytes, stored {m} bytes` | API (`SI-03.7`) | Post-completion size check fails (per `phase-03-videos/TD-11` revision) |
| `UNSUPPORTED_MEDIA: {detail}` | Worker (`SI-03.9`) | ffprobe finds no video stream, or a container outside `mp4`/`webm` — thrown as `UnrecoverableError`, no retries (per `phase-03-videos/TD-09` revision) |
| `PROCESSING_FAILED: {error message}` | Worker (`SI-03.9`) | Any other error on the final attempt (`job.attemptsMade >= job.opts.attempts`) |
| `UPLOAD_ABANDONED` | Worker (`SI-03.12`) | Draft older than 24h with an open multipart upload (per `phase-03-videos/TD-12` revision) |

### Events/Messages

Queue backend: BullMQ on Redis (per `phase-03-videos/TD-01`); pinned `@nestjs/bullmq@^11.0.5` + `bullmq@^6.3.8` (per `phase-03-videos/TD-01` revision). Producers live in the API process; consumers live in the worker process (per `phase-03-videos/TD-05`).

#### Job `process-video` (queue `video-processing`)

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job options:** `jobId: videoId`, `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }` (per `phase-03-videos/TD-09` revision)
**Producer:** `VideoProcessingQueue` (`POST /videos/:slug/upload/complete`, after the status moves to `processing`) (per `phase-03-videos/TD-09`)
**Consumer:** `VideoProcessingProcessor` in the worker (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`)
**Trigger:** multipart upload completed and verified
**Processing:** load the video; if `status` is already `ready`, return (idempotent); run ffprobe on an internal presigned GET URL of `storage_key` (no local copy of the original); reject non-video / non-allowlisted containers with `UnrecoverableError`; extract one frame (`-ss` at 10% of the duration, capped to the duration) to a temp JPEG; `PutObject` it to `thumbnail_key`; persist `duration_seconds`, `width`, `height`, `metadata`, `thumbnail_key` and `status = ready` in one update
**Failure handling:** on `failed`, write `status = error` + `processing_error` only when `job.attemptsMade >= job.opts.attempts` or the error is `UnrecoverableError` (per `phase-03-videos/TD-09` revision)
**Delivery semantics:** at-least-once — the consumer must be idempotent (per `phase-03-videos/TD-01`, `phase-03-videos/TD-09`)

#### Job `sweep-abandoned-uploads` (queue `video-maintenance`)

**Payload:**

```json
{}
```

**Job options:** job scheduler id `abandoned-upload-sweep`, `every: 3600000` (hourly), registered idempotently with `upsertJobScheduler` on worker boot (per `phase-03-videos/TD-12` revision)
**Producer:** BullMQ job scheduler (registered by `VideoMaintenanceProcessor` on worker start) (per `phase-03-videos/TD-12`)
**Consumer:** `VideoMaintenanceProcessor` in the worker (per `phase-03-videos/TD-12`)
**Trigger:** every hour
**Processing:** select `status = draft` videos with a non-null `upload_id` and `created_at` older than 24h; for each, `AbortMultipartUpload`, clear `upload_id`, set `status = error` and `processing_error = 'UPLOAD_ABANDONED'`
**Delivery semantics:** at-least-once — re-running the sweep is harmless (the query only matches still-open drafts; an already-aborted upload is ignored)

---

## Dependency Map

```
SI-03.1 (root — deps, config, MinIO/Redis, ffmpeg)
├── SI-03.2 — StorageModule (needs MinIO + storageConfig)
├── SI-03.3 — Video entity + migration (needs nanoid)
│   └── SI-03.4 — BullMQ queues + producer (needs Redis/queueConfig + VideosModule)
└── SI-03.8 — MediaProbeService (needs ffmpeg/ffprobe in the image)

SI-03.2 + SI-03.3
└── SI-03.5 — POST /videos (draft pre-registration + multipart start)
    └── SI-03.6 — POST /videos/:slug/upload/part-urls (introduces findOwnedBySlug)
        ├── SI-03.10 — GET /videos/:slug
        │   └── SI-03.11 — GET /videos/:slug/stream + /download
        └── (with SI-03.4) SI-03.7 — POST /videos/:slug/upload/complete

SI-03.2 + SI-03.3 + SI-03.4 + SI-03.8
└── SI-03.9 — video worker (standalone app + process-video processor + Compose service)
    └── SI-03.12 — abandoned-upload sweep (scheduler + processor)

SI-03.5 + SI-03.6 + SI-03.7 + SI-03.10 + SI-03.11
└── SI-03.13 — OpenAPI docs + openapi.json

SI-03.7 + SI-03.9 + SI-03.11
└── SI-03.14 — full pipeline e2e (API + MinIO + Redis + video-worker)

SI-03.12 + SI-03.13 + SI-03.14
└── SI-03.15 — CLAUDE.md + architecture diagram
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.8 (parallel) → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7, SI-03.10 (parallel) → SI-03.9 → SI-03.11 → SI-03.12, SI-03.13 (parallel) → SI-03.14 → SI-03.15

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências, configuração e serviços MinIO/Redis no Compose
- [ ] SI-03.2 — Módulo de storage S3/MinIO
- [ ] SI-03.3 — Entidade Video, migration e gerador de slug
- [ ] SI-03.4 — Filas BullMQ e produtor do job de processamento
- [ ] SI-03.5 — Endpoint POST /videos (pré-cadastro do rascunho e início do upload)
- [ ] SI-03.6 — Endpoint POST /videos/:slug/upload/part-urls (retomada do upload)
- [ ] SI-03.7 — Endpoint POST /videos/:slug/upload/complete (conclusão e enfileiramento)
- [ ] SI-03.8 — Serviço de mídia: ffprobe e extração de frame via child_process
- [ ] SI-03.9 — Worker de vídeo: entrypoint standalone e processamento do job
- [ ] SI-03.10 — Endpoint GET /videos/:slug (detalhe e status do vídeo)
- [ ] SI-03.11 — Endpoints GET /videos/:slug/stream e /download (streaming e download)
- [ ] SI-03.12 — Varredura de uploads abandonados
- [ ] SI-03.13 — Documentação OpenAPI dos endpoints de vídeo
- [ ] SI-03.14 — Teste ponta a ponta do pipeline (upload → worker → streaming)
- [ ] SI-03.15 — Documentação: CLAUDE.md e diagrama de arquitetura

**Phase deliverables (from `docs/project-plan.md`):**

- [ ] Upload de até 10GB funcional — bytes enviados direto ao MinIO via multipart pré-assinado, sem passar pela API (SI-03.5, SI-03.6, SI-03.7)
- [ ] Processamento automático do vídeo — duração, metadados e thumbnail gerados pelo `video-worker` (SI-03.9)
- [ ] Streaming funcionando — `Range` → `206 Partial Content` provado por teste (SI-03.11, SI-03.14)
- [ ] URLs únicas geradas — `slug` curto e único por vídeo (SI-03.3, SI-03.5)
- [ ] `minio`, `redis` e `video-worker` sobem com `docker compose up -d` junto com o backend (SI-03.1, SI-03.9)

**Full test suites** _(all commands run inside the container, per `nestjs-project/CLAUDE.md`)_:

- [ ] Unit + integration tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass, with `video-worker` running (`docker compose exec nestjs-api npm run test:e2e -- --runInBand`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully, including the worker entrypoint (`docker compose exec nestjs-api npm run build`)
