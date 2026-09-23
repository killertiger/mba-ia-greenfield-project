# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `curl -f http://localhost:9000/minio/health/live` — expect HTTP 200
- **MinIO bucket:** the one-shot `minio-init` service must show `Exited (0)`; it creates the `streamtube` bucket idempotently

The `video-worker` service is part of the infrastructure — it is a queue consumer, not the HTTP
application, so `docker compose up -d` starts it and `docker compose ps` must show it `running`.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `redis` — Redis 7, port `6379`, BullMQ backend
- `minio` — S3-compatible object storage, API on `9000`, console on `9001`
- `minio-init` — one-shot job that creates the `streamtube` bucket and exits
- `video-worker` — standalone Nest application context (no HTTP port) that consumes the
  `video-processing` and `video-maintenance` queues; same image and source volume as `nestjs-api`
- `mailpit` — SMTP capture, UI on `8025`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm run start:worker                     # Video worker (compiled)
npm run start:worker:dev                 # Video worker with hot-reload

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose logs video-worker
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
curl http://localhost:3000
curl -f http://localhost:9000/minio/health/live
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

Integration and e2e suites run against the **real** Compose services — Postgres, MinIO and Redis
are never mocked. Two consequences:

- The infrastructure must be up (`docker compose up -d`) before running them.
- `test/videos-pipeline.e2e-spec.ts` additionally needs the `video-worker` container running: it
  waits for the worker to move a video to `ready` and fails after 60s otherwise.

Both suites exit on their own — **do not add `--forceExit`**. If Jest ever hangs, it is reporting a
real leak (a `DataSource` that was not destroyed, an app that was not closed); run
`npx jest --detectOpenHandles` and fix the leak instead of forcing the exit.

One exception is already handled centrally: `@css-inline/css-inline`, a native binding that the
Handlebars mail adapter imports at load time, registers a `CustomGC` handle that is never released.
Both Jest configs map it to `test/stubs/css-inline.stub.ts`, which is a no-op because the mail
templates contain no CSS.

### Media binaries

`Dockerfile.dev` installs `ffmpeg` (which also provides `ffprobe`). `MediaProbeService` spawns both
with `spawn(..., { shell: false })` and an argument array — never a shell string — so paths with
spaces or shell metacharacters stay a single argument. Video fixtures are generated at test time by
`test/fixtures/sample-video.ts`; no binary media file is committed to the repository.

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Storage Endpoints: the one documented exception to Docker networking

The root `CLAUDE.md` requires Compose service names as hosts. Object storage has **two** endpoints
because presigned URLs are consumed outside the Docker network:

- `S3_ENDPOINT=http://minio:9000` — container-to-container (the API and the worker talk to MinIO).
- `S3_PUBLIC_ENDPOINT=http://localhost:9000` — the host that the **client** (browser, or an HTTP
  tool on the host machine) uses. Presigned URLs are signed for this host, so it must be reachable
  from outside the network. `localhost` here is correct and is not a violation of the rule.

`StorageService` keeps one `S3Client` per endpoint and picks between them with the `audience`
option (`'internal'` vs `'public'`). Under Jest, `test/setup-test-env.ts` forces
`S3_PUBLIC_ENDPOINT = S3_ENDPOINT`, because tests run *inside* the container and cannot resolve
`localhost:9000`.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

### Two entrypoints, one codebase

| Entrypoint | Root module | Bootstrap | Loads |
|---|---|---|---|
| `src/main.ts` | `AppModule` | `NestFactory.create` (HTTP) | Controllers, auth, mailer, Swagger |
| `src/worker.ts` | `WorkerModule` | `NestFactory.createApplicationContext` (no HTTP) | `VideoProcessingModule` only |

`DatabaseModule` holds the single `TypeOrmModule.forRootAsync` used by both, so connection
parameters are never duplicated. `WorkerModule` also imports `UsersModule`: `autoLoadEntities` only
discovers entities registered by modules in the graph, and `Video` relates to `Channel`, which
relates to `User`.

Queue-facing code is split by process: producers (`VideoProcessingQueue`) live in the API,
consumers (`VideoProcessingProcessor`, `VideoMaintenanceProcessor`) live in the worker.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
