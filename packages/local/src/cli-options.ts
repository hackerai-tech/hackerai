export interface CliOptions {
  token: string;
  name?: string;
  convexUrl?: string;
}

export const CONNECT_HELP =
  'Open HackerAI Settings > Remote Control, choose "Copy connect command", and run it in your terminal.';

/** Validate before creating a client or touching local connection state. */
export function parseCliOptions(args: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set(["--token", "--name", "--convex-url"]);
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
  if (!token) throw new Error("No authentication token provided.");
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
  return { token, name: values.get("--name"), convexUrl };
}
