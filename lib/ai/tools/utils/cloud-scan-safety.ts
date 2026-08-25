import type { AnySandbox, ToolContext } from "@/types";
import { isAwsLambdaMicrovmSandbox } from "./sandbox-types";

const CLOUD_SCAN_BLOCK_MESSAGE =
  "HackerAI Cloud permits bounded port scans of one target and at most 1,000 ports. This command used or obscured a broader scope, so it was blocked before execution, the Cloud connection was closed, and MicroVM termination was attempted. Narrow the command to one target and 1,000 or fewer ports, or use HackerAI Desktop or Remote Control for larger authorized scans.";

const HIGH_THROUGHPUT_SCANNERS = [
  "hping",
  "hping2",
  "hping3",
  "masscan",
  "naabu",
  "nmap",
  "nping",
  "rustscan",
  "unicornscan",
  "zgrab",
  "zgrab2",
  "zmap",
] as const;

type HighThroughputScanner = (typeof HIGH_THROUGHPUT_SCANNERS)[number];

export type CloudScanSafetyDetection = {
  scanner: HighThroughputScanner | "bulk_http_probe";
  reason: "host_port_scanner" | "bulk_http_probe";
};

export type CloudScanSafetyResult =
  | { blocked: false }
  | {
      blocked: true;
      error: string;
      microvmId: string;
      scanner: CloudScanSafetyDetection["scanner"];
      terminationStatus:
        "terminated" | "already_gone" | "ownership_not_found" | "failed";
    };

const safeScannerIntrospectionPattern = new RegExp(
  String.raw`^\s*(?:(?:command\s+-v|which|type)\s+(?:${HIGH_THROUGHPUT_SCANNERS.join(
    "|",
  )})|(?:${HIGH_THROUGHPUT_SCANNERS.join(
    "|",
  )})\s+(?:--version|-V|--help|-h))\s*$`,
  "i",
);

const shellWrapperPattern =
  /^(?:[^\s]*\/)?(?:bash|sh|zsh)\s+-[a-z]*c\s+(["'])([\s\S]*)\1(?:\s+[\s\S]*)?$/i;

const stripHeredocBodies = (command: string): string => {
  const lines = command.split("\n");
  const kept: string[] = [];
  let delimiter: string | null = null;
  let stripTabs = false;

  for (const line of lines) {
    if (delimiter) {
      const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === delimiter) {
        delimiter = null;
        stripTabs = false;
      }
      continue;
    }
    kept.push(line);
    const match = line.match(/<<(-)?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/);
    if (match) {
      stripTabs = Boolean(match[1]);
      delimiter = match[2];
    }
  }
  return kept.join("\n");
};

type ShellCommandSegment = { command: string; receivesPipe: boolean };

const shellCommandSegments = (rawCommand: string): ShellCommandSegment[] => {
  const command = stripHeredocBodies(rawCommand);
  const segments: ShellCommandSegment[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let receivesPipe = false;

  const push = (end: number) => {
    const segment = command.slice(start, end).trim();
    if (segment) segments.push({ command: segment, receivesPipe });
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (
      char === ";" ||
      char === "|" ||
      char === "(" ||
      char === ")" ||
      char === "\n"
    ) {
      push(index);
      const logicalOr = char === "|" && command[index + 1] === char;
      if (logicalOr) {
        index++;
      }
      receivesPipe = char === "|" && !logicalOr;
      start = index + 1;
      continue;
    }
    if (char === "&" && command[index + 1] === "&") {
      push(index);
      index++;
      receivesPipe = false;
      start = index + 1;
    }
  }
  push(command.length);
  return segments;
};

const shellTokens = (segment: string): string[] =>
  (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
    token
      .replace(/^(["'])([\s\S]*)\1$/, "$2")
      .replace(/\\([A-Za-z0-9._/-])/g, "$1"),
  );

const EXECUTION_WRAPPERS = new Set([
  "command",
  "env",
  "exec",
  "ionice",
  "nice",
  "nohup",
  "stdbuf",
  "sudo",
  "taskset",
  "time",
  "timeout",
  "xargs",
]);

const WRAPPER_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  env: new Set(["-C", "-S", "-u", "--chdir", "--split-string", "--unset"]),
  ionice: new Set(["-c", "-n", "-p", "-P", "-u"]),
  nice: new Set(["-n", "--adjustment"]),
  stdbuf: new Set(["-e", "-i", "-o", "--error", "--input", "--output"]),
  sudo: new Set([
    "-C",
    "-D",
    "-g",
    "-h",
    "-p",
    "-R",
    "-r",
    "-T",
    "-t",
    "-u",
    "--chdir",
    "--group",
    "--host",
    "--prompt",
    "--role",
    "--type",
    "--user",
  ]),
  time: new Set(["-f", "-o", "--format", "--output"]),
  timeout: new Set(["-k", "-s", "--kill-after", "--signal"]),
  xargs: new Set([
    "-a",
    "-d",
    "-E",
    "-I",
    "-L",
    "-n",
    "-P",
    "-s",
    "--arg-file",
    "--delimiter",
    "--eof",
    "--max-args",
    "--max-chars",
    "--max-lines",
    "--max-procs",
    "--replace",
  ]),
};

const executableName = (token: string): string =>
  token.split("/").at(-1)?.toLowerCase() ?? "";

const skipWrapperOptions = (
  tokens: string[],
  start: number,
  wrapper: string,
): number => {
  const valueOptions = WRAPPER_VALUE_OPTIONS[wrapper] ?? new Set<string>();
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") return index + 1;
    if (!token.startsWith("-") || token === "-") break;
    const option = token.split("=", 1)[0];
    index++;
    if (valueOptions.has(option) && token === option) index++;
  }
  return index;
};

const resolveExecutedCommand = (
  tokens: string[],
): { index: number; name: string } | null => {
  let index = 0;
  while (/^[A-Z_][A-Z0-9_]*=/i.test(tokens[index] ?? "")) index++;

  while (index < tokens.length) {
    const name = executableName(tokens[index]);
    if (!EXECUTION_WRAPPERS.has(name)) return { index, name };
    index = skipWrapperOptions(tokens, index + 1, name);
    while (/^[A-Z_][A-Z0-9_]*=/i.test(tokens[index] ?? "")) index++;
    if (name === "timeout" || name === "taskset") index++;
  }
  return null;
};

const nestedShellPayload = (tokens: string[]): string | null => {
  const command = resolveExecutedCommand(tokens);
  if (!command) return null;
  if (command.name === "eval") {
    return tokens.slice(command.index + 1).join(" ");
  }
  if (!/^(?:bash|sh|zsh)$/.test(command.name)) return null;
  const args = tokens.slice(command.index + 1);
  const commandOption = args.findIndex((token) =>
    /^-[A-Za-z]*c[A-Za-z]*$/.test(token),
  );
  return commandOption < 0 ? null : (args[commandOption + 1] ?? null);
};

const scannerInExecutingPosition = (
  segment: string,
): {
  scanner: HighThroughputScanner;
  tokens: string[];
  index: number;
} | null => {
  const tokens = shellTokens(segment);
  const command = resolveExecutedCommand(tokens);
  if (
    !command ||
    !HIGH_THROUGHPUT_SCANNERS.includes(command.name as HighThroughputScanner)
  )
    return null;
  return {
    scanner: command.name as HighThroughputScanner,
    tokens,
    index: command.index,
  };
};

const NMAP_VALUE_OPTIONS = new Set([
  "--datadir",
  "--dns-servers",
  "--exclude",
  "--excludefile",
  "--exclude-ports",
  "--host-timeout",
  "--max-parallelism",
  "--max-rate",
  "--max-retries",
  "--min-parallelism",
  "--min-rate",
  "--proxies",
  "--scan-delay",
  "--script",
  "--script-args",
  "--script-args-file",
  "--script-help",
  "--script-timeout",
  "--source-port",
  "--spoof-mac",
  "--stylesheet",
  "--version-intensity",
  "--max-hostgroup",
  "--min-hostgroup",
  "--max-rtt-timeout",
  "--min-rtt-timeout",
  "--initial-rtt-timeout",
  "--max-scan-delay",
  "--max-os-tries",
  "--mtu",
  "--port-ratio",
  "--ttl",
  "-D",
  "-S",
  "-e",
  "-g",
  "-oA",
  "-oG",
  "-oN",
  "-oX",
]);

const NAABU_VALUE_OPTIONS = new Set([
  "--exclude-cdn",
  "--exclude-hosts",
  "--exclude-ports",
  "--output",
  "--rate",
  "--retries",
  "--scan-type",
  "--timeout",
  "-c",
  "-ec",
  "-eh",
  "-ep",
  "-o",
  "-rate",
  "-retries",
  "-scan-type",
  "-timeout",
]);

const countPortSpec = (value: string): number => {
  let count = 0;
  for (const rawPart of value.split(",")) {
    const part = rawPart.replace(/^[TUSAP]+:/i, "");
    if (part === "-") return Number.POSITIVE_INFINITY;
    if (/^\d+$/.test(part)) {
      count++;
      continue;
    }
    const range = part.match(/^(\d+)-(\d+)$/);
    if (!range) return Number.POSITIVE_INFINITY;
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start < 0 || end < start || end > 65_535) {
      return Number.POSITIVE_INFINITY;
    }
    count += end - start + 1;
    if (count > 1_000) return count;
  }
  return count;
};

const targetIsSingleHost = (target: string): boolean => {
  if (!target || /[*,{}[\]?$`~\\]/.test(target)) return false;
  if (/(?:^|\.)\d+-\d+(?:\.|$)/.test(target)) return false;
  if (!target.includes("/")) return true;
  return /\/32$/.test(target) || /\/128$/.test(target);
};

const probeTargetIsSingleHost = (target: string): boolean => {
  if (/^https?:\/\//i.test(target)) {
    try {
      return targetIsSingleHost(new URL(target).hostname);
    } catch {
      return false;
    }
  }
  return targetIsSingleHost(target);
};

const isBoundedCloudPortScan = (
  scanner: HighThroughputScanner,
  tokens: string[],
  scannerIndex: number,
): boolean => {
  if (scanner !== "nmap" && scanner !== "naabu") return false;

  const valueOptions =
    scanner === "nmap" ? NMAP_VALUE_OPTIONS : NAABU_VALUE_OPTIONS;
  const targets: string[] = [];
  let requestedPorts = scanner === "nmap" ? 1_000 : 100;

  for (let index = scannerIndex + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (
      token === "-iL" ||
      token === "-iR" ||
      token === "-l" ||
      token === "-list" ||
      token === "--list"
    ) {
      return false;
    }

    if (token === "-p" || token === "--ports" || token === "-port") {
      const value = tokens[++index];
      if (!value) return false;
      requestedPorts = countPortSpec(value);
      continue;
    }
    const explicitPorts = token.match(/^(?:--ports|-port)=(.+)$/i);
    if (explicitPorts) {
      requestedPorts = countPortSpec(explicitPorts[1]);
      continue;
    }
    if (/^-p(?:\d|[TUSAP]:|-)/i.test(token)) {
      requestedPorts = countPortSpec(token.slice(2));
      continue;
    }
    if (token === "--top-ports" || token === "-top-ports" || token === "-tp") {
      const value = tokens[++index];
      if (!value || !/^\d+$/.test(value)) return false;
      requestedPorts = Number(value);
      continue;
    }
    const explicitTopPorts = token.match(
      /^(?:--top-ports|-top-ports|-tp)=(.+)$/i,
    );
    if (explicitTopPorts) {
      if (!/^\d+$/.test(explicitTopPorts[1])) return false;
      requestedPorts = Number(explicitTopPorts[1]);
      continue;
    }
    if (token === "-host" || token === "--host") {
      const value = tokens[++index];
      if (!value) return false;
      targets.push(value);
      continue;
    }
    const explicitHost = token.match(/^(?:-host|--host)=(.+)$/i);
    if (explicitHost) {
      targets.push(explicitHost[1]);
      continue;
    }

    const optionName = token.split("=", 1)[0];
    if (valueOptions.has(optionName)) {
      if (!token.includes("=")) index++;
      continue;
    }
    if (token.startsWith("-")) continue;
    targets.push(token);
  }

  return (
    requestedPorts <= 1_000 &&
    targets.length === 1 &&
    targetIsSingleHost(targets[0])
  );
};

const isBulkHttpProbe = (segment: ShellCommandSegment): boolean => {
  const tokens = shellTokens(segment.command);
  const command = resolveExecutedCommand(tokens);
  if (!command || !/^(?:nuclei|httpx)$/i.test(command.name)) return false;
  const args = tokens.slice(command.index + 1);
  if (
    args.length === 1 &&
    /^(?:-h|--help|-version|--version)$/i.test(args[0])
  ) {
    return false;
  }
  if (args.some((token) => /^(?:-l|-list|--list)(?:=|$)/i.test(token))) {
    return true;
  }
  const targets: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const assignedTarget = args[index].match(
      /^(?:-u|--url|-target|--target)=(\S+)$/i,
    );
    if (assignedTarget) {
      targets.push(assignedTarget[1]);
    } else if (/^(?:-u|--url|-target|--target)$/i.test(args[index])) {
      if (!args[index + 1]) return true;
      targets.push(args[index + 1]);
      index++;
    }
  }
  targets.push(
    ...args.filter(
      (token, index) =>
        !token.startsWith("-") &&
        /^https?:\/\//i.test(token) &&
        !/^(?:-u|--url|-target|--target)$/i.test(args[index - 1] ?? ""),
    ),
  );
  if (targets.length === 0) return segment.receivesPipe;
  return targets.length !== 1 || !probeTargetIsSingleHost(targets[0]);
};

/**
 * Detect commands that can fan out across hosts or ports fast enough to put
 * HackerAI's shared AWS egress identity at risk. This deliberately does not
 * inspect or retain targets.
 */
export function detectCloudScanCommand(
  command: string,
): CloudScanSafetyDetection | null {
  if (!command.trim() || safeScannerIntrospectionPattern.test(command)) {
    return null;
  }

  const topLevelWrappedCommand = command.trim().match(shellWrapperPattern)?.[2];
  if (topLevelWrappedCommand) {
    return detectCloudScanCommand(topLevelWrappedCommand);
  }

  for (const segment of shellCommandSegments(command)) {
    const wrappedCommand = segment.command.match(shellWrapperPattern)?.[2];
    if (wrappedCommand) {
      const wrappedDetection = detectCloudScanCommand(wrappedCommand);
      if (wrappedDetection) return wrappedDetection;
    }

    const nestedPayload = nestedShellPayload(shellTokens(segment.command));
    if (nestedPayload) {
      const nestedDetection = detectCloudScanCommand(nestedPayload);
      if (nestedDetection) return nestedDetection;
    }

    const scannerMatch = scannerInExecutingPosition(segment.command);
    if (scannerMatch) {
      const scannerArgs = scannerMatch.tokens.slice(scannerMatch.index + 1);
      if (
        scannerArgs.length === 1 &&
        /^(?:-h|--help|-V|--version)$/i.test(scannerArgs[0])
      ) {
        continue;
      }
      if (
        isBoundedCloudPortScan(
          scannerMatch.scanner,
          scannerMatch.tokens,
          scannerMatch.index,
        )
      ) {
        continue;
      }
      return {
        scanner: scannerMatch.scanner,
        reason: "host_port_scanner",
      };
    }

    if (isBulkHttpProbe(segment)) {
      return {
        scanner: "bulk_http_probe",
        reason: "bulk_http_probe",
      };
    }
  }

  return null;
}

/** Reconstruct the current interactive shell line without retaining history. */
export function updateTerminalScanSafetyInput(
  currentLine: string,
  input: string,
): { inspection: string; currentLine: string } {
  let line = currentLine;
  const submitted: string[] = [];
  for (const char of input) {
    if (char === "\r" || char === "\n") {
      submitted.push(line);
      line = "";
    } else if (char === "\u0003" || char === "\u0015") {
      line = "";
    } else if (char === "\b" || char === "\u007f") {
      line = line.slice(0, -1);
    } else if (char >= " " || char === "\t") {
      line += char;
    }
  }
  return {
    inspection: [...submitted, line].filter(Boolean).join("\n"),
    currentLine: line.slice(-64 * 1024),
  };
}

const environment = () =>
  process.env.TRIGGER_ENV ??
  process.env.VERCEL_ENV ??
  process.env.NODE_ENV ??
  "unknown";

const logSafetyEvent = (
  level: "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) => {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    service: fields.trigger_run_id ? "agent-long" : "chat-handler",
    environment: environment(),
    request_id: fields.trigger_run_id ?? process.env.VERCEL_REQUEST_ID ?? null,
    ...fields,
  });
  if (level === "error") console.error(payload);
  else console.warn(payload);
};

type SafetyDependencies = {
  terminate: (args: {
    userId: string;
    microvmId: string;
    scanner: CloudScanSafetyDetection["scanner"];
  }) => Promise<{
    status: "terminated" | "already_gone" | "ownership_not_found";
  }>;
};

const defaultDependencies: SafetyDependencies = {
  terminate: async (args) => {
    const { terminateAwsLambdaMicrovmForSafety } =
      await import("./aws-lambda-microvm");
    return terminateAwsLambdaMicrovmForSafety(args);
  },
};

/** Block the command and contain only the current AWS MicroVM. */
export async function enforceCloudScanSafety(args: {
  command: string;
  sandbox: AnySandbox;
  context: Pick<
    ToolContext,
    "chatId" | "sandboxManager" | "subscription" | "triggerRunId" | "userID"
  >;
  toolCallId: string;
  source: "terminal_exec" | "terminal_interaction";
  dependencies?: SafetyDependencies;
}): Promise<CloudScanSafetyResult> {
  if (!isAwsLambdaMicrovmSandbox(args.sandbox)) return { blocked: false };

  const detection = detectCloudScanCommand(args.command);
  if (!detection) return { blocked: false };

  const microvmId = args.sandbox.getConnectionId();
  const correlation = {
    trigger_run_id: args.context.triggerRunId ?? null,
    chat_id: args.context.chatId,
    user_id: args.context.userID,
    subscription: args.context.subscription ?? "unknown",
    tool_call_id: args.toolCallId,
    microvm_id: microvmId,
    source: args.source,
    scanner: detection.scanner,
    reason: detection.reason,
    command_length: args.command.length,
  };
  logSafetyEvent("warn", "cloud_scan_command_blocked", correlation);

  let terminationStatus: Extract<
    CloudScanSafetyResult,
    { blocked: true }
  >["terminationStatus"] = "failed";
  try {
    const result = await (args.dependencies ?? defaultDependencies).terminate({
      userId: args.context.userID,
      microvmId,
      scanner: detection.scanner,
    });
    terminationStatus = result.status;
    logSafetyEvent("warn", "cloud_scan_session_contained", {
      ...correlation,
      termination_status: terminationStatus,
    });
  } catch (error) {
    logSafetyEvent("error", "cloud_scan_session_containment_failed", {
      ...correlation,
      failure_class: error instanceof Error ? error.name : typeof error,
    });
  } finally {
    await args.context.sandboxManager
      .resetSandbox?.("cloud_scan_safety_guard")
      .catch((error) => {
        logSafetyEvent("error", "cloud_scan_sandbox_reset_failed", {
          ...correlation,
          failure_class: error instanceof Error ? error.name : typeof error,
        });
      });
  }

  return {
    blocked: true,
    error: CLOUD_SCAN_BLOCK_MESSAGE,
    microvmId,
    scanner: detection.scanner,
    terminationStatus,
  };
}
