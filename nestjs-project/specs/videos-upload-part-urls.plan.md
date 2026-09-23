---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload-part-urls.e2e-spec.ts
---

# POST /videos/:slug/upload/part-urls Test Plan

## Application Overview

`POST /videos/:slug/upload/part-urls` is the resume path of a video upload: for a draft whose multipart upload is still open, it re-issues presigned `UploadPart` URLs for the requested part numbers, so a client whose connection dropped (or whose URLs expired) uploads only the missing parts. Only the owner of the video's channel may call it, and only while the video is `draft`.

## Test Scenarios

### 1. Re-issuing part URLs

**Setup:** Bootstrap `AppModule` with the global pipes/filters from `main.ts`. In `beforeAll`, create two authenticated users — the owner and another user — via `test/helpers/authenticated-user.ts` (once per file; auth endpoints are throttled to 10 req/min). `beforeEach` deletes rows from `videos`, then the owner calls `POST /videos` with `{ "fileName": "clip.mp4", "mimeType": "video/mp4", "sizeBytes": 209715200 }` to obtain a draft with `partCount: 2`.

#### 1.1. reissues-url-for-requested-part

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. POST /videos/{slug}/upload/part-urls as the owner with body `{ "partNumbers": [2] }`
    - expect: status 200
    - expect: `parts` has exactly one entry with `partNumber: 2` and a non-empty `url`
    - expect: `partUrlsExpireAt` is an ISO-8601 timestamp in the future

#### 1.2. reissued-url-accepts-part-bytes

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. Owner calls POST /videos with `{ "fileName": "small.mp4", "mimeType": "video/mp4", "sizeBytes": 1024 }`
    - expect: status 201 with `partCount: 1`
  2. POST /videos/{slug}/upload/part-urls as the owner with body `{ "partNumbers": [1] }`
    - expect: status 200
  3. HTTP PUT 1024 bytes to the re-issued `parts[0].url`
    - expect: status 200 with a non-empty `ETag` header (acceptance of this ETag by the complete endpoint is exercised in the SI-03.7 spec)

### 2. Rejections

**Setup:** Same as group 1.

#### 2.1. rejects-part-number-out-of-range

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. POST /videos/{slug}/upload/part-urls as the owner with body `{ "partNumbers": [3] }` (video has `partCount: 2`)
    - expect: status 400
    - expect: body `error: "VALIDATION_ERROR"`

#### 2.2. rejects-empty-part-list

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. POST /videos/{slug}/upload/part-urls as the owner with body `{ "partNumbers": [] }`
    - expect: status 400
    - expect: body `error: "VALIDATION_ERROR"`

#### 2.3. hides-video-from-non-owner

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. POST /videos/{slug}/upload/part-urls as the other user with body `{ "partNumbers": [1] }`
    - expect: status 404
    - expect: body `error: "VIDEO_NOT_FOUND"`
  2. POST /videos/AAAAAAAAAAA/upload/part-urls as the owner (well-formed slug that does not exist)
    - expect: status 404 with `error: "VIDEO_NOT_FOUND"`

#### 2.4. rejects-when-upload-no-longer-open

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. Set the draft's `status` to `processing` directly in the `videos` table
  2. POST /videos/{slug}/upload/part-urls as the owner with body `{ "partNumbers": [1] }`
    - expect: status 409
    - expect: body `error: "VIDEO_NOT_IN_DRAFT"`
