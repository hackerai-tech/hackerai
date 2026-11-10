import type { AnySandbox } from "@/types";
import {
  isCentrifugoSandbox,
  isE2BSandbox,
} from "@/lib/ai/tools/utils/sandbox-types";
import {
  HTTP_RETEST_LIMITS,
  httpRetestRunnerOutputSchema,
  type HttpRetestRecipe,
  type HttpRetestRunnerOutput,
} from "./http-retest";
import {
  HTTP_RETEST_INPUT_ENV,
  HTTP_RETEST_PYTHON_PROGRAM,
  HTTP_RETEST_RESULT_MARKER,
} from "./http-retest-python";

/** Extra time for interpreter start-up and relay delivery beyond the run budget. */
const COMMAND_MARGIN_MS = 10_000;
export const HTTP_RETEST_COMMAND_TIMEOUT_MS =
  HTTP_RETEST_LIMITS.runDeadlineMs + COMMAND_MARGIN_MS;

type PlanStep = {
  kind: "baseline" | "probe";
  index: number;
  path: string;
  headers: Array<[string, string]>;
  status: number;
  json: Array<{ path: string[]; equals: string | number | boolean | null }>;
  contains: string[];
  nonrepro: number[] | null;
};

export type HttpRetestPlan = {
  scheme: "http" | "https";
  host: string;
  port: number;
  timeout_s: number;
  deadline_s: number;
  max_bytes: number;
  steps: PlanStep[];
};

export type HttpRetestRuntimeResult =
  | { kind: "observed"; output: HttpRetestRunnerOutput }
  | {
      kind: "failed";
      reason: "runtime_unavailable" | "runner_failed" | "timeout";
    };

const credentialHeader = (
  recipe: HttpRetestRecipe,
  name: string | null,
  credentials: Readonly<Record<string, string>>,
): Array<[string, string]> => {
  if (name === null) return [];
  const binding = recipe.credentials.find((c) => c.name === name);
  const value = credentials[name];
  if (!binding || value === undefined)
    throw new Error("A required runtime credential is missing");
  if (binding.placement === "bearer")
    return [["Authorization", `Bearer ${value}`]];
  if (binding.placement === "cookie") return [["Cookie", value]];
  return [[binding.header_name!, value]];
};

/** Compile a validated recipe and runtime credentials into the runner plan. */
export function compileHttpRetestPlan(
  recipe: HttpRetestRecipe,
  credentials: Readonly<Record<string, string>>,
): HttpRetestPlan {
  const origin = new URL(recipe.origin);
  const scheme = origin.protocol === "https:" ? "https" : "http";
  const step = (
    kind: PlanStep["kind"],
    index: number,
    request: HttpRetestRecipe["probe"] | HttpRetestRecipe["baselines"][number],
    predicate: HttpRetestRecipe["probe"]["vulnerable"],
    nonrepro: number[] | null,
  ): PlanStep => ({
    kind,
    index,
    path: request.path,
    headers: [
      ...request.headers.map(
        (header) => [header.name, header.value] as [string, string],
      ),
      ...credentialHeader(recipe, request.credential, credentials),
    ],
    status: predicate.status,
    json: predicate.json.map((check) => ({
      path: check.json_path.split("."),
      equals: check.equals,
    })),
    contains: predicate.body_contains,
    nonrepro,
  });
  return {
    scheme,
    // URL keeps IPv6 brackets; sockets need the bare address.
    host: origin.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: origin.port ? Number(origin.port) : scheme === "https" ? 443 : 80,
    timeout_s: recipe.timeout_ms / 1000,
    deadline_s: HTTP_RETEST_LIMITS.runDeadlineMs / 1000,
    max_bytes: HTTP_RETEST_LIMITS.maxResponseBytes,
    steps: [
      ...recipe.baselines.map((baseline, index) =>
        step("baseline", index, baseline, baseline.expect, null),
      ),
      step(
        "probe",
        0,
        recipe.probe,
        recipe.probe.vulnerable,
        recipe.probe.not_reproduced.statuses,
      ),
    ],
  };
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Isolated mode ignores PYTHON* variables, user site packages and the cwd. */
export const HTTP_RETEST_COMMAND = `python3 -I -S -c ${quote(
  HTTP_RETEST_PYTHON_PROGRAM,
)}`;

/** Accept only the runner's marked, schema-valid line. */
export function parseHttpRetestRunnerStdout(
  stdout: string,
): HttpRetestRunnerOutput | "fatal" | null {
  if (stdout.length > 64 * 1024) return null;
  const line = stdout
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith(HTTP_RETEST_RESULT_MARKER));
  if (!line) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(HTTP_RETEST_RESULT_MARKER.length));
  } catch {
    return null;
  }
  if (value && typeof value === "object" && "fatal" in value) return "fatal";
  const parsed = httpRetestRunnerOutputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type CommandResult = { stdout: string; exitCode: number };

const readExitFailure = (error: unknown): CommandResult | null => {
  // E2B reports a non-zero exit as an exception carrying its result. Read only
  // the fields we need; never log or rethrow the error text.
  if (!error || typeof error !== "object") return null;
  const exitCode = Object.getOwnPropertyDescriptor(error, "exitCode")?.value;
  const stdout = Object.getOwnPropertyDescriptor(error, "stdout")?.value;
  return typeof exitCode === "number"
    ? { exitCode, stdout: typeof stdout === "string" ? stdout : "" }
    : null;
};

/**
 * Execute the fixed runner on the already selected sandbox. Credentials are
 * delivered over stdin (local) or one process environment variable (cloud);
 * never in command arguments.
 */
export async function runHttpRetestInSandbox({
  sandbox,
  recipe,
  credentials,
}: {
  sandbox: AnySandbox;
  recipe: HttpRetestRecipe;
  credentials: Readonly<Record<string, string>>;
}): Promise<HttpRetestRuntimeResult> {
  const plan = JSON.stringify(compileHttpRetestPlan(recipe, credentials));
  let result: CommandResult;
  try {
    if (isE2BSandbox(sandbox)) {
      result = await sandbox.commands.run(HTTP_RETEST_COMMAND, {
        envs: {
          [HTTP_RETEST_INPUT_ENV]: Buffer.from(plan, "utf8").toString("base64"),
        },
        timeoutMs: HTTP_RETEST_COMMAND_TIMEOUT_MS,
      });
    } else if (isCentrifugoSandbox(sandbox)) {
      if (sandbox.isWindows() || !sandbox.supportsCommandStdin())
        return { kind: "failed", reason: "runtime_unavailable" };
      result = await sandbox.commands.run(HTTP_RETEST_COMMAND, {
        stdin: plan,
        timeoutMs: HTTP_RETEST_COMMAND_TIMEOUT_MS,
        displayName: "",
      });
    } else {
      return { kind: "failed", reason: "runtime_unavailable" };
    }
  } catch (error) {
    const exited = readExitFailure(error);
    if (!exited) return { kind: "failed", reason: "runner_failed" };
    result = exited;
  }
  if (result.exitCode === 127)
    return { kind: "failed", reason: "runtime_unavailable" };
  const output = parseHttpRetestRunnerStdout(result.stdout);
  if (output === null || output === "fatal" || result.exitCode !== 0)
    return { kind: "failed", reason: "runner_failed" };
  return { kind: "observed", output };
}
