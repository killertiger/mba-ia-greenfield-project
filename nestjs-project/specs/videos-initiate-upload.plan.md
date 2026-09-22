---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos-initiate-upload.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` starts a video upload: it pre-registers the video as `draft` in the caller's channel, opens an S3 multipart upload in MinIO, and returns one presigned `UploadPart` URL per part so the client sends the file bytes directly to storage — the API never receives them. The endpoint requires an access token and validates the declared file metadata (MIME allowlist, size up to 10737418240 bytes).

## Test Scenarios

### 1. Upload initiation

**Setup:** Bootstrap `AppModule` with the same global `ValidationPipe`, `DomainExceptionFilter` and `ValidationExceptionFilter` as `main.ts`. In `beforeAll`, create one authenticated user (register → confirm via Mailpit → login) through `test/helpers/authenticated-user.ts` — created once per file because the global `ThrottlerGuard` limits auth endpoints to 10 req/min. `beforeEach` deletes rows from `videos`. MinIO, Redis and Postgres are the real Compose services.

#### 1.1. initiates-upload-and-returns-part-urls

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. POST /videos with bearer token and body `{ "fileName": "clip.mp4", "mimeType": "video/mp4", "sizeBytes": 209715200 }`
    - expect: status 201
    - expect: body has `id` (uuid), `slug` (11 chars `[0-9A-Za-z]`), `title: "clip"`, `status: "draft"`
    - expect: `partSizeBytes: 104857600` and `partCount: 2`
    - expect: `parts` has 2 entries with `partNumber` 1 and 2, each with a non-empty `url`
    - expect: `partUrlsExpireAt` is an ISO-8601 timestamp in the future

#### 1.2. persists-draft-with-open-upload

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. POST /videos with bearer token and body `{ "fileName": "clip.mp4", "mimeType": "video/mp4", "sizeBytes": 209715200 }`
    - expect: status 201
  2. Query the `videos` row by the returned `id`
    - expect: `status = draft`
    - expect: `channel_id` equals the authenticated user's channel id
    - expect: `upload_id` is not null
    - expect: `title = clip`, `part_size_bytes = 104857600`, `part_count = 2`
    - expect: `storage_key = videos/{id}/original.mp4`

#### 1.3. presigned-part-url-accepts-bytes-directly

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. POST /videos with bearer token and body `{ "fileName": "small.mp4", "mimeType": "video/mp4", "sizeBytes": 1024 }`
    - expect: status 201 with `partCount: 1`
  2. HTTP PUT 1024 bytes to `parts[0].url` (directly to MinIO, no API involved)
    - expect: status 200
    - expect: response has a non-empty `ETag` header

### 2. Validation and authentication

**Setup:** Same as group 1.

#### 2.1. rejects-unsupported-mime-type

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. POST /videos with bearer token and body `{ "fileName": "clip.avi", "mimeType": "video/x-msvideo", "sizeBytes": 1024 }`
    - expect: status 400
    - expect: body `error: "VALIDATION_ERROR"`
    - expect: no row is created in `videos`

#### 2.2. rejects-size-above-limit

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. POST /videos with bearer token and body `{ "fileName": "big.mp4", "mimeType": "video/mp4", "sizeBytes": 10737418241 }`
    - expect: status 400
    - expect: body `error: "VALIDATION_ERROR"`
  2. POST /videos with bearer token and body `{ "fileName": "max.mp4", "mimeType": "video/mp4", "sizeBytes": 10737418240 }`
    - expect: status 201 with `partCount: 103`

#### 2.3. requires-access-token

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. POST /videos without `Authorization` header and a valid body
    - expect: status 401
    - expect: no row is created in `videos`

### 3. Unique URL identifier

**Setup:** Same as group 1.

#### 3.1. assigns-distinct-slugs

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. POST /videos twice with the same bearer token and body `{ "fileName": "clip.mp4", "mimeType": "video/mp4", "sizeBytes": 1024 }`
    - expect: both return 201
    - expect: the two `slug` values differ and the two `id` values differ
