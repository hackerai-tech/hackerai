/** A confirmed missing source permits looking up a legacy relative path. */
export class SandboxFileNotFoundError extends Error {
  constructor(path: string) {
    super(`File not found: ${path}`);
    this.name = "SandboxFileNotFoundError";
  }
}
