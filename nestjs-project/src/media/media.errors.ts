/** A media binary exited with a non-zero status, timed out, or could not be spawned. */
export class MediaCommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(
      `${command} failed${exitCode === null ? '' : ` with exit code ${exitCode}`}: ${stderr}`,
    );
    this.name = 'MediaCommandError';
  }
}
