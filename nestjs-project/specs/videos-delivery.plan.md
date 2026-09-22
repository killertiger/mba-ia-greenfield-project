---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: test/videos-delivery.e2e-spec.ts
---

# GET /videos/:slug/stream and /download Test Plan

## Application Overview

`GET /videos/:slug/stream` and `GET /videos/:slug/download` hand the owner a presigned `GetObject` URL for a `ready` video. The client then talks to storage directly: streaming relies on HTTP `Range` requests answered by storage with `206 Partial Content` (no full download needed), and download uses a `Content-Disposition: attachment` override. The API only signs URLs — video bytes never pass through it.

## Test Scenarios

### 1. Streaming and download of a ready video

**Setup:** Bootstrap `AppModule` with the global pipes/filters from `main.ts`. In `beforeAll`, create two authenticated users — owner and other — via `test/helpers/authenticated-user.ts` (once per file; auth endpoints are throttled to 10 req/min). `beforeEach` deletes rows from `videos`, then arranges a ready video directly: owner creates the draft via `POST /videos` with `{ "fileName": "clip.mp4", "mimeType": "video/mp4", "sizeBytes": 4096 }`, the test uploads 4096 known bytes to the video's `storage_key` via `StorageService.putObject` and updates the row to `status = ready`. Presigned URLs are fetched from inside the container (the Jest setup sets `S3_PUBLIC_ENDPOINT = S3_ENDPOINT`, per `phase-03-videos/TD-10`).

#### 1.1. issues-stream-url

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. GET /videos/{slug}/stream as the owner
    - expect: status 200
    - expect: body has a non-empty `url` and an ISO-8601 `expiresAt` between 3h50m and 4h10m from now

#### 1.2. stream-url-serves-partial-content

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. GET /videos/{slug}/stream as the owner and take `url`
  2. HTTP GET `url` with header `Range: bytes=0-1023`
    - expect: status 206
    - expect: header `Content-Range: bytes 0-1023/4096`
    - expect: body is exactly the first 1024 uploaded bytes

#### 1.3. download-url-forces-attachment

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. GET /videos/{slug}/download as the owner and take `url`
    - expect: status 200 with non-empty `url` and `expiresAt`
  2. HTTP GET `url` without `Range`
    - expect: status 200
    - expect: header `Content-Disposition: attachment; filename="clip.mp4"`
    - expect: body is the full 4096 uploaded bytes

### 2. Rejections

**Setup:** Same as group 1.

#### 2.1. rejects-video-not-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. Update the video row to `status = processing`
  2. GET /videos/{slug}/stream as the owner
    - expect: status 409 with `error: "VIDEO_NOT_READY"`
  3. GET /videos/{slug}/download as the owner
    - expect: status 409 with `error: "VIDEO_NOT_READY"`

#### 2.2. hides-video-from-non-owner

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-22T00:21:06Z

**Steps:**
  1. GET /videos/{slug}/stream as the other user
    - expect: status 404 with `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/{slug}/download as the other user
    - expect: status 404 with `error: "VIDEO_NOT_FOUND"`
