---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-21T09:04:47-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-21T19:32:58-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-21T09:04:47-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-21T09:04:47-03:00"
  docs/phases/phase-02-auth/context.md: "2026-09-21T09:04:47-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-09-21T09:04:47-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-21T09:04:47-03:00"
  .claude/skills/testing-guide-nestjs-project/references/external-systems.md: "2026-09-21T09:04:47-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

> Depende de: Fase 01, Fase 02

Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única.

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** _None named explicitly in the Phase 03 section of `docs/project-plan.md`._

**Deferred subprojects:** _None._

**Sequencing notes:** "> Depende de: Fase 01, Fase 02". No deferred-pass or ordering sentences within the phase.

**Attention notes** (`docs/project-plan.md` § 4 Pontos de Atenção, verbatim):

- **Upload de arquivos grandes:** o upload de até 10GB precisa ser feito de forma que não trave o sistema e permita retomar em caso de falha de conexão.
- **Processamento de vídeos:** a extração de informações do vídeo é pesada e deve acontecer em segundo plano, sem bloquear o usuário.
- **URLs únicas:** cada vídeo precisa de uma URL curta e única que nunca conflite com outro vídeo.
- **Armazenamento:** vídeos grandes consomem muito espaço. É importante planejar o crescimento e os custos de armazenamento desde o início.
- **Streaming:** o vídeo deve começar a ser reproduzido sem que o usuário precise baixar o arquivo inteiro.

**Neighbors (for boundary detection only):**

- **Phase 02 (Cadastro, Login e Gerenciamento de Conta):** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04 (Gerenciamento de Vídeos e Canal; Depende de: Fase 02, Fase 03):** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A: BullMQ + Redis (`@nestjs/bullmq`) | — |
| phase-03-videos/TD-02 | phase | Cross-layer | Upload Protocol for Files up to 10GB | decided | A: Presigned S3/MinIO Multipart Upload (client-driven) | — |
| phase-03-videos/TD-03 | phase | Backend | S3/MinIO Client Library | decided | A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` + `@aws-sdk/lib-storage`) | — |
| phase-03-videos/TD-04 | phase | Backend | Storage Key & Bucket Organization | decided | A: Single bucket, type-prefixed keys | — |
| phase-03-videos/TD-05 | phase | Backend | Worker Application Architecture | decided | A: NestJS Standalone Application Context (separate entrypoint, same codebase) | — |
| phase-03-videos/TD-06 | phase | Backend | Video Processing — FFmpeg/ffprobe Integration | decided | A: `fluent-ffmpeg` wrapper library | — |
| phase-03-videos/TD-07 | phase | Cross-layer | Unique Video URL Identifier Strategy | decided | C: Short opaque ID via `nanoid` (as a dedicated public slug, alongside a UUID primary key) | — |
| phase-03-videos/TD-08 | phase | Cross-layer | Video Delivery Strategy (Streaming & Download) | decided | A: Presigned GET URL, direct-to-storage | — |
| phase-03-videos/TD-09 | phase | Cross-layer | Video Status Lifecycle & Processing Failure Policy | decided | B: Same 4 states + persisted failure reason + queue-native retries | — |
| phase-03-videos/TD-10 | phase | Cross-layer | Storage Endpoint Configuration for Presigned URLs | decided | A: Two endpoints — internal for server operations, public for presigning | — |
| phase-03-videos/TD-11 | phase | Cross-layer | Upload Acceptance Policy (Size Enforcement, Formats, Part Size) | decided | B: Declared at initiation + verified after completion | — |
| phase-03-videos/TD-12 | phase | Backend | Abandoned Upload Cleanup | decided | A: Scheduled sweep via a BullMQ job scheduler in the worker | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-12 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-05 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-10, phase-03-videos/TD-11 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-09, phase-03-videos/TD-11, phase-03-videos/TD-12 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-09 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-04, phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08, phase-03-videos/TD-10, phase-03-videos/TD-11 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08, phase-03-videos/TD-10 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** The phase brief explicitly frames the queue as the "principal decisão de stack da fase" expecting dedicated infrastructure, not a workaround to avoid it. BullMQ's native `attempts`/`backoff`/`failed`-event API maps directly onto TD-09's failure-handling requirement with the least custom code, and `@nestjs/bullmq` is an officially maintained package confirmed compatible with the installed NestJS 11.
**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** It is the only option that fully removes file bytes from the API's path while adding no new infrastructure beyond the already-mandated MinIO, and it gives resumability as a side effect of chunking rather than requiring a dedicated resumable-upload server.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** Since the project explicitly frames MinIO as a stand-in for production S3, using AWS's own SDK removes migration risk entirely, and its documented multipart commands are exactly the primitives TD-02's client-driven presigned flow needs.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** Minimizes MinIO bootstrap for this phase and groups a video's assets under one prefix; Option B's access-policy benefit is not needed until Phase 04 introduces public visibility, and can be adopted later via bucket policy changes without a key-layout migration.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** The only option consistent with the already-decided separate-container architecture while maximizing code reuse; `NestFactory.createApplicationContext` is an official, documented technique for non-HTTP entrypoints sharing a Nest codebase.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** It covers both capabilities (`ffprobe` for metadata, `.screenshots()` for thumbnail) with less custom code; the `ffmpeg`/`ffprobe` binary dependency in the worker's Docker image is unavoidable either way, so the wrapper only removes CLI-argument/parsing burden, at no real cost.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** It is the only option that satisfies the literal short-URL requirement from `docs/project-plan.md`; UUID v4/v7 both remain 36 characters regardless of ordering. The dual-identifier pattern (internal PK vs. public-facing slug) is a small, well-precedented addition that leaves the existing UUID-PK convention untouched.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** It is the direct continuation of TD-02's non-blocking principle applied to reads, and it is literally what the C4 diagram already specifies; Option B would contradict an already-decided diagram relationship rather than propose a genuinely open alternative.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** It answers the "what happens on processing failure" question from the challenge with a concrete, low-cost mechanism (persisted `processing_error` + queue-native retries), without building a manual-retry API surface that belongs to a later phase's video-management scope.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** It keeps every container-to-container call on the Compose service name as the project rule requires, while making the client-facing host explicit configuration that maps directly to S3/CDN in production. Proposed lifetimes: upload part URLs short-lived (e.g. 1h — a client resuming after expiry requests fresh URLs for the remaining parts), GET URLs longer (e.g. 4h, covering a long viewing session per TD-08), both as env-configurable values validated by Joi.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** It turns the 10GB limit and the format allowlist into enforced rules using `HeadObject` and ffprobe, which the stack already needs, without depending on unverified MinIO signature behavior (Option C) or trusting the client (Option A). Proposed parameters: allowlist `video/mp4` and `video/webm` (browser-playable without transcoding, which TD-08's direct streaming requires); server-fixed part size of 100 MiB (≈103 parts for 10GB, well inside the 10000-part limit), returned to the client in the initiation response.
**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** It is the only option that works identically on the local MinIO stack and on S3 while cleaning both storage and the draft rows, and it adds no infrastructure beyond TD-01/TD-05. MinIO's own server-side expiry of stale uploads was not confirmed in the sources consulted, so it is not relied on. Option D is the fallback if the team prefers not to add scope to this phase.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger
**Revisions:**
- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions... _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and... _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` § 3 Feature Implementation Checklist)_

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

External-system strategies (`testing-guide-nestjs-project/references/external-systems.md`): PostgreSQL — real (Docker `db`); Email — Mailpit (real SMTP capture); Message Queue — real broker in Docker (technology was TBD in the guide); Object Storage — guide text states "Local Filesystem" adapter in dev/tests.
