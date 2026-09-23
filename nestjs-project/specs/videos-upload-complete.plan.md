---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:slug/upload/complete Test Plan

## Application Overview

`POST /videos/:slug/upload/complete` finalizes a video upload. It completes the S3 multipart upload with the part `ETag`s the client collected, verifies the stored object's size against the declared `sizeBytes` (and the 10737418240-byte limit), moves the video from `draft` to `processing` and enqueues the `process-video` job (queue `video-processing`, `jobId` = video id). A size mismatch deletes the object and moves the video to `error`; invalid parts leave the video `draft` so the client can retry.

## Test Scenarios

### 1. Successful completion

**Setup:** Bootstrap `AppModule` with the global pipes/filters from `main.ts`. In `beforeAll`, create one authenticated user via `test/helpers/authenticated-user.ts` (once per file; auth endpoints are throttled to 10 req/min). `beforeEach` deletes rows from `videos` and obliterates the `video-processing` queue (obtained with `app.get(getQueueToken('video-processing'))`). Uploads use a single part (`sizeBytes: 1024`, `partCount: 1`) — the last/only part of a multipart upload has no minimum size, so no 100 MiB payload is needed; multi-part completion is covered by the SI-03.7 integration test.

#### 1.1. completes-upload-and-moves-to-processing

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. POST /videos with `{ "fileName": "clip.mp4", "mimeType": "video/mp4", "sizeBytes": 1024 }`, then HTTP PUT 1024 bytes to `parts[0].url` and keep the `ETag`
    - expect: PUT returns 200
  2. POST /videos/{slug}/upload/complete with `{ "parts": [{ "partNumber": 1, "etag": "<ETag>" }] }`
    - expect: status 202
    - expect: body `{ id, slug, status: "processing" }`
  3. Query the `videos` row
    - expect: `status = processing`, `uploaded_at` is not null, `upload_id` is null

#### 1.2. enqueues-process-video-job

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. Upload and complete as in 1.1
    - expect: status 202
  2. Read the `video-processing` queue
    - expect: exactly one job named `process-video` with `data.videoId` equal to the video `id` and `id`/`opts.jobId` equal to the video `id`

#### 1.3. repeated-complete-is-rejected-without-new-job

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. Upload and complete as in 1.1
    - expect: status 202
  2. POST /videos/{slug}/upload/complete again with the same body
    - expect: status 409
    - expect: body `error: "VIDEO_NOT_IN_DRAFT"`
  3. Read the `video-processing` queue
    - expect: still exactly one `process-video` job for this video

### 2. Rejected completion

**Setup:** Same as group 1.

#### 2.1. invalid-etag-keeps-draft

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. POST /videos with `{ "fileName": "clip.mp4", "mimeType": "video/mp4", "sizeBytes": 1024 }`, then PUT 1024 bytes to `parts[0].url`
  2. POST /videos/{slug}/upload/complete with `{ "parts": [{ "partNumber": 1, "etag": "\"00000000000000000000000000000000\"" }] }`
    - expect: status 422
    - expect: body `error: "UPLOAD_PARTS_INVALID"`
  3. Query the `videos` row
    - expect: `status = draft` and `upload_id` unchanged (not null)

#### 2.2. size-mismatch-deletes-object-and-marks-error

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. POST /videos with `{ "fileName": "clip.mp4", "mimeType": "video/mp4", "sizeBytes": 1024 }`, then PUT only 512 bytes to `parts[0].url` and keep the `ETag`
  2. POST /videos/{slug}/upload/complete with `{ "parts": [{ "partNumber": 1, "etag": "<ETag>" }] }`
    - expect: status 422
    - expect: body `error: "UPLOAD_SIZE_MISMATCH"`
  3. Query the `videos` row
    - expect: `status = error`, `upload_id` is null, `processing_error` starts with `UPLOAD_SIZE_MISMATCH`
  4. HEAD the video's `storage_key` in MinIO
    - expect: the object does not exist
  5. Read the `video-processing` queue
    - expect: no job for this video

#### 2.3. rejects-incomplete-part-set

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. POST /videos with `{ "fileName": "clip.mp4", "mimeType": "video/mp4", "sizeBytes": 1024 }` (`partCount: 1`)
  2. POST /videos/{slug}/upload/complete with `{ "parts": [{ "partNumber": 2, "etag": "\"abc\"" }] }`
    - expect: status 400
    - expect: body `error: "VALIDATION_ERROR"`
  3. POST /videos/{slug}/upload/complete with `{ "parts": [] }`
    - expect: status 400 with `error: "VALIDATION_ERROR"`
