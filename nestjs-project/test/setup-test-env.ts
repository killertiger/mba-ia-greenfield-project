// Tests run inside the nestjs-api container, where the client-facing
// S3_PUBLIC_ENDPOINT (localhost) is unreachable. Presigned URLs must be signed
// for a host the test process can call, so tests use the internal endpoint.
if (process.env.S3_ENDPOINT) {
  process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
}
