export const MAX_NARROW_NMAP_PORTS = 16;

export type CloudPortScanClassification = {
  scanner: "masscan" | "naabu" | "netcat" | "nmap";
  scanKind: "broad_tcp" | "raw" | "udp" | "zero_io_connect";
};

export const E2B_PORT_SCAN_BLOCK_MESSAGE =
  "Blocked an unreliable Cloud Agent port scan. E2B networking can make closed ports appear open, so this command's results cannot be treated as confirmed evidence. Do not retry this scan or claim that any ports are confirmed from E2B scan output. Use the HackerAI Desktop App or Remote Control for native TCP, UDP, or raw network scanning. Narrow application-level checks are still available when appropriate, such as curl for HTTP, openssl s_client for TLS, or ssh for SSH.";

const SHELL_SEPARATORS = new Set([";", "\n", "|"]);
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SCANNER_NAMES = new Set([
  "masscan",
  "naabu",
  "nc",
  "ncat",
  "netcat",
  "nmap",
]);

function tokenizeShellCommands(command: string): string[][] {
  const commands: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flushToken = () => {
    if (token) tokens.push(token);
    token = "";
  };
  const flushCommand = () => {
    flushToken();
    if (tokens.length > 0) commands.push(tokens);
    tokens = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "#" && token === "") {
      while (index + 1 < command.length && command[index + 1] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (/\s/.test(char)) {
      if (char === "\n") flushCommand();
      else flushToken();
      continue;
    }

    if (SHELL_SEPARATORS.has(char) || char === "&") {
      flushCommand();
      if ((char === "|" || char === "&") && command[index + 1] === char) {
        index += 1;
      }
      continue;
    }

    token += char;
  }

  if (escaped) token += "\\";
  flushCommand();
  return commands;
}

function basename(token: string): string {
  return (
    token.replace(/^\(+/, "").replace(/\)+$/, "").split("/").pop() ?? token
  );
}

function skipOptions(
  tokens: string[],
  start: number,
  optionsWithValues: ReadonlySet<string> = new Set(),
): number {
  let index = start;
  while (index < tokens.length && tokens[index].startsWith("-")) {
    const option = tokens[index];
    index += 1;
    if (!option.includes("=") && optionsWithValues.has(option)) index += 1;
  }
  return index;
}

function resolveInvocation(
  tokens: string[],
): { name: string; args: string[] } | null {
  let index = 0;
  while (index < tokens.length && ASSIGNMENT_PATTERN.test(tokens[index]))
    index += 1;

  while (index < tokens.length) {
    const name = basename(tokens[index]);
    if (name === "env") {
      index = skipOptions(tokens, index + 1, new Set(["-u", "--unset"]));
      while (index < tokens.length && ASSIGNMENT_PATTERN.test(tokens[index]))
        index += 1;
      continue;
    }

    if (name === "sudo") {
      index = skipOptions(
        tokens,
        index + 1,
        new Set([
          "-C",
          "--close-from",
          "-D",
          "--chdir",
          "-g",
          "--group",
          "-h",
          "--host",
          "-p",
          "--prompt",
          "-R",
          "--chroot",
          "-r",
          "--role",
          "-T",
          "--command-timeout",
          "-t",
          "--type",
          "-u",
          "--user",
        ]),
      );
      continue;
    }

    if (name === "timeout") {
      index = skipOptions(
        tokens,
        index + 1,
        new Set(["-k", "--kill-after", "-s", "--signal"]),
      );
      if (index < tokens.length) index += 1;
      continue;
    }

    if (name === "command" || name === "nohup") {
      index = skipOptions(tokens, index + 1);
      continue;
    }

    if (name === "nice") {
      index = skipOptions(tokens, index + 1, new Set(["-n", "--adjustment"]));
      continue;
    }

    if (name === "stdbuf") {
      index = skipOptions(
        tokens,
        index + 1,
        new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
      );
      continue;
    }

    return { name, args: tokens.slice(index + 1) };
  }

  return null;
}

function hasShortFlag(args: string[], flag: string): boolean {
  return args.some((arg) => {
    if (!arg.startsWith("-") || arg.startsWith("--")) return false;
    return arg.slice(1).includes(flag);
  });
}

function getOptionValue(
  args: string[],
  shortName: string,
  longName?: string,
): string | null {
  const attachedShortValue = /^-[^-]$/.test(shortName);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === shortName || (longName && arg === longName)) {
      return args[index + 1] ?? "";
    }
    if (attachedShortValue && arg.startsWith(shortName)) {
      return arg.slice(shortName.length);
    }
    if (shortName.startsWith("--") && arg.startsWith(`${shortName}=`)) {
      return arg.slice(shortName.length + 1);
    }
    if (longName && arg.startsWith(`${longName}=`)) {
      return arg.slice(longName.length + 1);
    }
  }
  return null;
}

function countPortSpec(portSpec: string): number {
  let count = 0;
  for (const rawPart of portSpec.split(",")) {
    const part = rawPart.replace(/^[TUSP]:/i, "");
    if (!part) return Number.POSITIVE_INFINITY;
    const range = part.match(/^(\d*)-(\d*)$/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : 65535;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        return Number.POSITIVE_INFINITY;
      }
      count += end - start + 1;
    } else if (/^\d+$/.test(part) || /^[A-Za-z][A-Za-z0-9_-]*$/.test(part)) {
      count += 1;
    } else {
      return Number.POSITIVE_INFINITY;
    }
    if (count > MAX_NARROW_NMAP_PORTS) return count;
  }
  return count;
}

function classifyNmap(args: string[]): CloudPortScanClassification | null {
  const scanModes = args
    .filter((arg) => /^-s[A-Za-z]+$/.test(arg))
    .flatMap((arg) => arg.slice(2).split(""));

  if (scanModes.includes("U")) {
    return { scanner: "nmap", scanKind: "udp" };
  }

  const rawModes = new Set(["A", "F", "I", "M", "N", "O", "S", "W", "X"]);
  if (
    scanModes.some((mode) => rawModes.has(mode)) ||
    args.includes("-A") ||
    args.includes("-O") ||
    args.includes("-sn") ||
    args.includes("--traceroute") ||
    args.some((arg) => arg === "--scanflags" || arg.startsWith("--scanflags="))
  ) {
    return { scanner: "nmap", scanKind: "raw" };
  }

  // Privileged nmap defaults to SYN scanning. A narrow exception must
  // explicitly request a TCP connect scan so it does not depend on raw packets.
  if (!scanModes.includes("T") && !scanModes.includes("L")) {
    return { scanner: "nmap", scanKind: "raw" };
  }

  // List scans enumerate inputs without probing ports.
  if (scanModes.includes("L")) return null;

  if (
    args.includes("-F") ||
    args.some(
      (arg) => arg === "--port-ratio" || arg.startsWith("--port-ratio="),
    )
  ) {
    return { scanner: "nmap", scanKind: "broad_tcp" };
  }

  const topPorts = getOptionValue(args, "--top-ports");
  if (topPorts !== null) {
    const count = Number(topPorts);
    return Number.isInteger(count) &&
      count > 0 &&
      count <= MAX_NARROW_NMAP_PORTS
      ? null
      : { scanner: "nmap", scanKind: "broad_tcp" };
  }

  const portSpec = getOptionValue(args, "-p", "--ports");
  if (portSpec === null || countPortSpec(portSpec) > MAX_NARROW_NMAP_PORTS) {
    return { scanner: "nmap", scanKind: "broad_tcp" };
  }

  return null;
}

function classifyInvocation(invocation: {
  name: string;
  args: string[];
}): CloudPortScanClassification | null {
  if (invocation.name === "masscan") {
    return { scanner: "masscan", scanKind: "raw" };
  }
  if (invocation.name === "naabu") {
    return { scanner: "naabu", scanKind: "broad_tcp" };
  }
  if (["nc", "ncat", "netcat"].includes(invocation.name)) {
    return hasShortFlag(invocation.args, "z") ||
      invocation.args.includes("--zero")
      ? { scanner: "netcat", scanKind: "zero_io_connect" }
      : null;
  }
  return invocation.name === "nmap" ? classifyNmap(invocation.args) : null;
}

function classifyCloudPortScanInternal(
  command: string,
  depth: number,
): CloudPortScanClassification | null {
  for (const tokens of tokenizeShellCommands(command)) {
    const invocation = resolveInvocation(tokens);
    if (!invocation) continue;

    if (SCANNER_NAMES.has(invocation.name)) {
      const classification = classifyInvocation(invocation);
      if (classification) return classification;
      continue;
    }

    if (
      invocation.name === "busybox" &&
      invocation.args.length > 0 &&
      SCANNER_NAMES.has(basename(invocation.args[0]))
    ) {
      const classification = classifyInvocation({
        name: basename(invocation.args[0]),
        args: invocation.args.slice(1),
      });
      if (classification) return classification;
      continue;
    }

    if (depth < 2 && ["bash", "dash", "sh", "zsh"].includes(invocation.name)) {
      const commandFlagIndex = invocation.args.findIndex(
        (arg) => /^-[^-]*c/.test(arg) || arg === "--command",
      );
      const nestedCommand = invocation.args[commandFlagIndex + 1];
      if (commandFlagIndex >= 0 && nestedCommand) {
        const classification = classifyCloudPortScanInternal(
          nestedCommand,
          depth + 1,
        );
        if (classification) return classification;
      }
    }
  }
  return null;
}

export function classifyCloudPortScan(
  command: string,
): CloudPortScanClassification | null {
  return classifyCloudPortScanInternal(command, 0);
}
