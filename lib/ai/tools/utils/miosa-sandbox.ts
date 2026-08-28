import type { CommonSandboxInterface } from "./sandbox-types";

/**
 * `@miosa/sdk` is an OPTIONAL dependency, loaded only when this provider is
 * selected. A project running `CLOUD_SANDBOX_PROVIDER=e2b` never installs or
 * imports it, so adding MIOSA support costs E2B users nothing - not an install,
 * not a byte of bundle.
 */
async function loadMiosaSdk(): Promise<any> {
  try {
    return await import("@miosa/sdk");
  } catch {
    throw new Error(
      "CLOUD_SANDBOX_PROVIDER=miosa requires the @miosa/sdk package. " +
        "Install it with: pnpm add @miosa/sdk",
    );
  }
}

/**
 * MIOSA sandbox provider.
 *
 * Implements the same `CommonSandboxInterface` that E2B and `CentrifugoSandbox`
 * satisfy, so the rest of the codebase does not learn a third vocabulary. It
 * carries `sandboxKind = "miosa"` to match the discriminant pattern already
 * used by `isCentrifugoSandbox`.
 *
 * MIOSA is a Firecracker microVM platform. The sandbox IS the image - the same
 * model as E2B's `Template().fromDockerfile()`, not a container inside a VM -
 * so `docker/Dockerfile` maps across without restructuring the agent.
 *
 * ## Two places the contract does not line up, and how each is handled
 *
 * 1. `getHost(port)` is SYNCHRONOUS here but MIOSA resolves a preview URL over
 *    the network. The host is therefore resolved once during `create()` and
 *    cached, so the accessor can stay synchronous. `prewarmHost(port)` exists
 *    for callers that need a port other than the one warmed at construction;
 *    calling `getHost` for an unwarmed port throws rather than returning a
 *    plausible-looking guess, because a wrong URL fails later and further away.
 *
 * 2. MIOSA has no file-delete endpoint today, so `files.remove` shells out to
 *    `rm -f`. It is marked below so it can be swapped for a native call when
 *    one exists, and it fails loudly on a non-zero exit rather than resolving
 *    as though the file were gone.
 */

export interface MiosaSandboxOptions {
  /** MIOSA API key. Defaults to MIOSA_API_KEY. */
  apiKey?: string;
  /** API base URL. Defaults to MIOSA_ENDPOINT, then the SDK default. */
  endpoint?: string;
  /** Template to boot. Defaults to MIOSA_TEMPLATE_ID. */
  templateId?: string;
  /** Shape: xs | small | medium | large | xl. */
  size?: string;
  /** Idle timeout in seconds before MIOSA pauses the sandbox. */
  timeoutSec?: number;
  /** Environment variables set on the sandbox at create time. */
  envVars?: Record<string, string>;
  /** Port to resolve a public host for during create. Defaults to 8080. */
  hostPort?: number;
}

type ExecOpts = {
  envVars?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  background?: boolean;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  signal?: AbortSignal;
};

export class MiosaSandbox implements CommonSandboxInterface {
  /** Discriminant, mirroring CentrifugoSandbox's `sandboxKind`. */
  readonly sandboxKind = "miosa" as const;

  private readonly hosts = new Map<number, string>();

  private constructor(
    private readonly client: any,
    private readonly sandbox: any,
    public readonly sandboxId: string,
  ) {}

  static async create(opts: MiosaSandboxOptions = {}): Promise<MiosaSandbox> {
    const apiKey = opts.apiKey ?? process.env.MIOSA_API_KEY;
    if (!apiKey) {
      throw new Error(
        "MIOSA_API_KEY is not set. MiosaSandbox cannot authenticate.",
      );
    }

    const { Miosa } = await loadMiosaSdk();
    const client = new Miosa({
      apiKey,
      ...((opts.endpoint ?? process.env.MIOSA_ENDPOINT)
        ? { baseUrl: opts.endpoint ?? process.env.MIOSA_ENDPOINT }
        : {}),
    });

    const sandbox = await client.sandboxes.create({
      template_id: opts.templateId ?? process.env.MIOSA_TEMPLATE_ID,
      size: opts.size,
      timeout_sec: opts.timeoutSec,
      env: opts.envVars,
    } as any);

    // Wait for the sandbox to be usable. A create that returns before the guest
    // agent is up will fail the first exec, which reads as a flaky agent rather
    // than a race.
    if (typeof (sandbox as any).waitUntilReady === "function") {
      await (sandbox as any).waitUntilReady();
    }

    const instance = new MiosaSandbox(client, sandbox, (sandbox as any).id);
    await instance.prewarmHost(opts.hostPort ?? 8080);
    return instance;
  }

  /** Reattach to an existing sandbox by id. */
  static async connect(
    sandboxId: string,
    opts: MiosaSandboxOptions = {},
  ): Promise<MiosaSandbox> {
    const apiKey = opts.apiKey ?? process.env.MIOSA_API_KEY;
    if (!apiKey) {
      throw new Error(
        "MIOSA_API_KEY is not set. MiosaSandbox cannot authenticate.",
      );
    }

    const { Miosa } = await loadMiosaSdk();
    const client = new Miosa({
      apiKey,
      ...((opts.endpoint ?? process.env.MIOSA_ENDPOINT)
        ? { baseUrl: opts.endpoint ?? process.env.MIOSA_ENDPOINT }
        : {}),
    });

    const sandbox = await client.sandboxes.get(sandboxId);
    return new MiosaSandbox(client, sandbox, sandboxId);
  }

  readonly commands = {
    run: async (
      command: string,
      opts: ExecOpts = {},
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      const options: Record<string, unknown> = {};
      if (opts.cwd) options.cwd = opts.cwd;
      if (opts.envVars) options.env = opts.envVars;
      if (typeof opts.timeoutMs === "number") {
        // MIOSA takes seconds. Round UP: rounding down would cut a command
        // short of the budget the caller asked for.
        options.timeoutSec = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
      }

      // Streaming path, used when the caller wants incremental output or can
      // abort. Falls through to the buffered call otherwise.
      if (opts.onStdout || opts.onStderr || opts.signal) {
        let stdout = "";
        let stderr = "";
        let exitCode = 0;

        for await (const event of this.sandbox.exec.stream(command, options)) {
          if (opts.signal?.aborted) break;

          const e = event as Record<string, any>;
          if (typeof e.line === "string" && e.type === "stderr") {
            stderr += e.line;
            opts.onStderr?.(e.line);
          } else if (typeof e.line === "string") {
            stdout += e.line;
            opts.onStdout?.(e.line);
          } else if (e.type === "exit") {
            exitCode = e.exit_code ?? e.exitCode ?? 0;
          }
        }

        return { stdout, stderr, exitCode };
      }

      const result = await this.sandbox.exec.run(command, options);
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? result.exit_code ?? 0,
      };
    },
  };

  readonly files = {
    write: async (path: string, content: string | Buffer): Promise<void> => {
      const body =
        typeof content === "string" ? content : new Uint8Array(content);
      await this.sandbox.files.write(path, body);
    },

    read: async (path: string): Promise<string> => {
      return this.sandbox.files.readText(path);
    },

    // MIOSA has no file-delete endpoint yet. Shelling out is the honest
    // implementation; swap for a native call when one exists.
    remove: async (path: string): Promise<void> => {
      const quoted = `'${path.replace(/'/g, `'\\''`)}'`;
      const result = await this.commands.run(`rm -f -- ${quoted}`);
      if (result.exitCode !== 0) {
        throw new Error(
          `MiosaSandbox.files.remove(${path}) failed (exit ${result.exitCode}): ${result.stderr}`,
        );
      }
    },

    list: async (path: string): Promise<{ name: string }[]> => {
      const listing = await this.sandbox.files.list(path);
      const entries = Array.isArray(listing)
        ? listing
        : ((listing as any)?.files ?? (listing as any)?.data ?? []);
      return entries.map((entry: any) => ({
        name: typeof entry === "string" ? entry : (entry.name ?? entry.path),
      }));
    },
  };

  /**
   * Resolve and cache the public host for `port`.
   *
   * Called during `create()` so `getHost` can stay synchronous, and available
   * to callers that later need a different port.
   */
  async prewarmHost(port: number): Promise<string> {
    const url = await this.sandbox.expose(port);
    const host = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    this.hosts.set(port, host);
    return host;
  }

  getHost(port: number): string {
    const host = this.hosts.get(port);
    if (!host) {
      // Deliberately throws rather than guessing a URL. A fabricated host fails
      // later, somewhere else, and reads as a network fault.
      throw new Error(
        `MiosaSandbox: host for port ${port} has not been resolved. ` +
          `Call await sandbox.prewarmHost(${port}) first.`,
      );
    }
    return host;
  }

  async close(): Promise<void> {
    await this.sandbox.destroy();
  }
}

/** Type guard matching the `isCentrifugoSandbox` / `isE2BSandbox` pattern. */
export function isMiosaSandbox(sandbox: unknown): sandbox is MiosaSandbox {
  return (
    sandbox !== null &&
    typeof sandbox === "object" &&
    "sandboxKind" in sandbox &&
    (sandbox as { sandboxKind?: unknown }).sandboxKind === "miosa"
  );
}
