import fs from "node:fs";

export interface CliOptions {
  token?: string;
  tokenFile?: string;
  name?: string;
  convexUrl?: string;
}

export const CONNECT_HELP =
  'Open HackerAI Settings > Remote Control, choose "Copy connect command", and run it in your terminal.';

/** Validate before creating a client or touching local connection state. */
export function parseCliOptions(args: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set(["--token", "--token-file", "--name", "--convex-url"]);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    // Do not echo unknown input: a misplaced value may be a credential.
    if (!flags.has(flag)) {
      throw new Error(
        "Unrecognized argument. Run with --help to see supported options.",
      );
    }
    if (values.has(flag)) throw new Error(`Provide ${flag} only once.`);
    const value = args[i + 1];
    if (!value?.trim() || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}.`);
    }
    values.set(flag, value);
  }

  const token = values.get("--token");
  const tokenFile = values.get("--token-file");
  if (Boolean(token) === Boolean(tokenFile)) {
    throw new Error(
      "Provide exactly one token source: --token or --token-file.",
    );
  }
  const convexUrl = values.get("--convex-url");
  if (convexUrl) {
    let url: URL;
    try {
      url = new URL(convexUrl);
    } catch {
      throw new Error(
        "Invalid --convex-url. Provide a complete http:// or https:// backend URL.",
      );
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "Invalid --convex-url. Use an http:// or https:// backend URL without credentials, query parameters, or a fragment.",
      );
    }
  }
  return {
    ...(token ? { token } : { tokenFile }),
    name: values.get("--name"),
    convexUrl,
  };
}

/** Read a benchmark connection token without placing it in process arguments. */
export function readProtectedTokenFile(path: string): string {
  let fd: number | undefined;
  try {
    // This path is used by the Linux benchmark container. Windows ACLs do not
    // expose the same private-mode guarantee through stat.mode.
    if (process.platform === "win32" || !fs.constants.O_NOFOLLOW) {
      throw new Error("Private token files require POSIX no-follow support.");
    }
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 256 ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new Error(
        "Token file must be a private regular file owned by this user.",
      );
    }
    const token = fs.readFileSync(fd, { encoding: "utf8" }).trim();
    if (!/^hsb_[0-9a-f]{64}$/.test(token)) {
      throw new Error("Token file has an invalid credential shape.");
    }
    return token;
  } catch {
    throw new Error("Unable to read a private Remote Control token file.");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
