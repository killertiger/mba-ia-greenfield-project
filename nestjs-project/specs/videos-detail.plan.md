---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-detail.e2e-spec.ts
---

# GET /videos/:slug Test Plan

## Application Overview

`GET /videos/:slug` returns a video to its owner with its lifecycle `status` (`draft`, `processing`, `ready`, `error`), the metadata extracted by the worker (duration, dimensions, codec details), a presigned `thumbnailUrl` once the thumbnail exists, and the `processingError` when processing failed. It is how the status cycle stored in the database becomes observable through the API.

## Test Scenarios

### 1. Video state by lifecycle stage

**Setup:** Bootstrap `AppModule` with the global pipes/filters from `main.ts`. In `beforeAll`, create two authenticated users — owner and other — via `test/helpers/authenticated-user.ts` (once per file; auth endpoints are throttled to 10 req/min). `beforeEach` deletes rows from `videos`. Videos in `ready`/`error` states are arranged directly (owner creates the draft through `POST /videos`, then the test updates the row and uploads a small JPEG to `videos/{id}/thumbnail.jpg` via `StorageService`) so this spec does not depend on the worker; the worker-driven path is covered by `test/videos-pipeline.e2e-spec.ts` (SI-03.14).

#### 1.1. returns-fresh-draft

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. Owner calls POST /videos with `{ "fileName": "clip.mp4", "mimeType": "video/mp4", "sizeBytes": 1024 }`
  2. GET /videos/{slug} as the owner
    - expect: status 200
    - expect: `status: "draft"`, `title: "clip"`, `mimeType: "video/mp4"`, `sizeBytes: 1024`
    - expect: `durationSeconds: null`, `width: null`, `height: null`, `metadata: null`, `thumbnailUrl: null`, `processingError: null`

#### 1.2. returns-ready-video-with-metadata-and-thumbnail

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. Arrange a ready video: row updated to `status = ready`, `duration_seconds = 2.000`, `width = 320`, `height = 240`, `metadata = { "videoCodec": "h264" }`, `thumbnail_key = videos/{id}/thumbnail.jpg`, and a JPEG uploaded to that key
  2. GET /videos/{slug} as the owner
    - expect: status 200 with `status: "ready"`, `durationSeconds: 2`, `width: 320`, `height: 240` (all JSON numbers)
    - expect: `thumbnailUrl` is a non-empty URL
  3. HTTP GET `thumbnailUrl`
    - expect: status 200 with `Content-Type: image/jpeg`

#### 1.3. returns-processing-error

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. Arrange a video with `status = error` and `processing_error = 'UNSUPPORTED_MEDIA: no video stream'`
  2. GET /videos/{slug} as the owner
    - expect: status 200 with `status: "error"` and `processingError: "UNSUPPORTED_MEDIA: no video stream"`

#### 1.4. returns-large-size-as-number

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. Owner calls POST /videos with `{ "fileName": "max.mp4", "mimeType": "video/mp4", "sizeBytes": 10737418240 }`
  2. GET /videos/{slug} as the owner
    - expect: status 200
    - expect: `sizeBytes` is the JSON number `10737418240` (not a string)

### 2. Ownership

**Setup:** Same as group 1.

#### 2.1. hides-video-from-non-owner

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. Owner calls POST /videos with a valid body
  2. GET /videos/{slug} as the other user
    - expect: status 404
    - expect: body `error: "VIDEO_NOT_FOUND"`
  3. GET /videos/not-a-slug as the owner (malformed slug)
    - expect: status 404 with `error: "VIDEO_NOT_FOUND"`
