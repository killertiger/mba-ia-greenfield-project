export class MultipartCompletionError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'MultipartCompletionError';
  }
}
