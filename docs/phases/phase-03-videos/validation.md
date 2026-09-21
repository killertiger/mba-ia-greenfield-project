---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-21T20:53:42-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-21T20:53:28-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Testing guide says local-FS storage in tests; TD-02/03/04 decide real MinIO/S3"
    resolved_by: phase-03-videos/TD-03
  - id: AMB-1
    status: resolved
    summary: "Who may stream/download a video in Phase 03 (owner-only vs anyone; by status)?"
    resolved_by: phase-03-videos/TD-08
  - id: AMB-2
    status: resolved
    summary: "Which metadata fields are extracted and persisted besides duration?"
    resolved_by: phase-03-videos/TD-06
  - id: AMB-3
    status: resolved
    summary: "Status transition triggers and queue retry parameters left unspecified by TD-09"
    resolved_by: phase-03-videos/TD-09, phase-03-videos/TD-11, phase-03-videos/TD-12
  - id: MD-1
    status: resolved
    summary: "No TD on client-reachable storage endpoint used to sign presigned URLs"
    resolved_by: phase-03-videos/TD-10
  - id: MD-2
    status: resolved
    summary: "No TD on upload acceptance policy: 10GB enforcement, formats, part size"
    resolved_by: phase-03-videos/TD-11
  - id: MD-3
    status: resolved
    summary: "No TD on cleanup of abandoned uploads (orphan drafts + multipart parts)"
    resolved_by: phase-03-videos/TD-12
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-10)_ — No TD on client-reachable storage endpoint used to sign presigned URLs.
- **MD-2** _(resolved_by phase-03-videos/TD-11)_ — No TD on upload acceptance policy: 10GB enforcement, formats, part size.
- **MD-3** _(resolved_by phase-03-videos/TD-12)_ — No TD on cleanup of abandoned uploads (orphan drafts + multipart parts).
- **IC-1** _(resolved_by phase-03-videos/TD-03)_ — Testing guide says local-FS storage in tests; TD-02/03/04 decide real MinIO/S3. Revision on TD-03: storage integration and e2e tests hit the real MinIO container; the testing guide's `external-systems.md` is updated during implementation.
- **AMB-1** _(resolved_by phase-03-videos/TD-08)_ — Who may stream/download a video in Phase 03. Revision on TD-08: owner only; non-`ready` video → 409.
- **AMB-2** _(resolved_by phase-03-videos/TD-06)_ — Which metadata fields are persisted. Revision on TD-06: typed `duration_seconds`, `width`, `height`, `size_bytes`, `mime_type` + `jsonb` `metadata`.
- **AMB-3** _(resolved_by phase-03-videos/TD-09, TD-11, TD-12)_ — Status transition triggers and queue parameters. Revisions: TD-09 (processing on complete, `jobId` = video id, 409 on repeat, 3 attempts / exponential 5s); TD-11 (rejected upload → object deleted, `error`, 422); TD-12 (24h TTL, hourly sweep).
