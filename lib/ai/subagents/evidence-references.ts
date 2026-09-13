import type { AnySandbox } from "@/types";
import { isCentrifugoSandbox } from "@/lib/ai/tools/utils/sandbox-types";
import { buildSandboxCommandOptions } from "@/lib/ai/tools/utils/sandbox-command-options";
import { assertSubagentSandboxIdentity } from "./sandbox-identity";
import type {
  SubagentStructuredResult,
  EvidenceVerification,
} from "./contracts";

export const EVIDENCE_CHECK_TIMEOUT_MS = 5_000;
export const MAX_EVIDENCE_REFS = 40; // Eight result refs plus eight coverage entries of four.
type FileState = "exists" | "missing" | "forbidden" | "unavailable";
export type CheckedSubagentResult = SubagentStructuredResult & {
  evidence_verification?: EvidenceVerification;
};

// Only saved paths have a storage adapter. URLs, terminal citations and opaque
// artifact IDs are not file records and must never be fetched or called verified.
export function evidenceFilePath(ref: string): string | undefined {
  const path = ref.startsWith("file:") ? ref.slice(5) : ref;
  if (/^\/\//.test(path) || /^\\\\/.test(path)) return undefined;
  if (
    !ref.startsWith("file:") &&
    !/^(?:\/|\.\.?\/|[A-Za-z]:[\\/])/.test(path)
  ) {
    return undefined;
  }
  if (!path || /[\x00-\x1f]/.test(path) || /^[a-z]+:\/\//i.test(path))
    return undefined;
  // Existing static citations use file:src/auth.ts:42; check the file, not the line.
  return path.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, "");
}

const permissionDenied = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  return (
    e.code === "EACCES" ||
    e.code === "EPERM" ||
    [401, 403].includes(Number(e.statusCode ?? e.status)) ||
    (typeof e.message === "string" &&
      /\b(permission denied|access denied|forbidden|unauthorized)\b/i.test(
        e.message,
      ))
  );
};

// os.path.exists hides permission/IO errors as false. Only explicit ENOENT or
// ENOTDIR establishes absence; never turn transport or permission failure into it.
export const EVIDENCE_STAT_SCRIPT = `import json, os, stat
states = []
for path in json.loads(os.environ['HACKERAI_EVIDENCE_PATHS']):
    try:
        info = os.stat(path)
        states.append('exists' if stat.S_ISREG(info.st_mode) else 'missing')
    except (FileNotFoundError, NotADirectoryError):
        states.append('missing')
    except PermissionError:
        states.append('forbidden')
    except OSError:
        states.append('unavailable')
print(json.dumps(states))`;

async function checkFiles(
  sandbox: AnySandbox,
  paths: string[],
  signal: AbortSignal,
  states: FileState[],
): Promise<FileState[]> {
  if (isCentrifugoSandbox(sandbox) && sandbox.supportsNativeFileRelay()) {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, paths.length) }, async () => {
        while (next < paths.length && !signal.aborted) {
          const index = next++;
          try {
            const result = await sandbox.files.stat(paths[index], {
              signal,
              timeoutMs: EVIDENCE_CHECK_TIMEOUT_MS,
            });
            states[index] =
              result.kind === "file"
                ? "exists"
                : result.kind === "missing" || result.kind === "not_file"
                  ? "missing"
                  : "unavailable";
          } catch (error) {
            if (permissionDenied(error)) states[index] = "forbidden";
          }
        }
      }),
    );
    return states;
  }
  // Older Windows command-only connections have no reliable bounded metadata
  // adapter. Preserve refs for retry instead of guessing shell or filesystem state.
  if (isCentrifugoSandbox(sandbox) && sandbox.isWindows())
    return paths.map(() => "unavailable");
  const command = `python3 - <<'HACKERAI_EVIDENCE_STAT'\n${EVIDENCE_STAT_SCRIPT}\nHACKERAI_EVIDENCE_STAT`;
  try {
    const result = await sandbox.commands.run(command, {
      ...buildSandboxCommandOptions(sandbox, undefined, {
        HACKERAI_EVIDENCE_PATHS: JSON.stringify(paths),
      }),
      timeoutMs: EVIDENCE_CHECK_TIMEOUT_MS,
      signal,
    });
    if (result.exitCode !== 0 || result.stdout.length > 1_024)
      return paths.map(() => "unavailable");
    const states: unknown = JSON.parse(result.stdout);
    if (
      !Array.isArray(states) ||
      states.length !== paths.length ||
      !states.every((state) =>
        ["exists", "missing", "forbidden", "unavailable"].includes(state),
      )
    ) {
      return paths.map(() => "unavailable");
    }
    return states as FileState[];
  } catch (error) {
    return paths.map(() =>
      permissionDenied(error) ? "forbidden" : "unavailable",
    );
  }
}

export async function verifyEvidenceReferences(args: {
  refs: string[];
  sandbox: AnySandbox;
  expectedSandboxIdentity: string | undefined;
  signal: AbortSignal;
  authorize: () => Promise<void>;
}): Promise<
  | {
      accepted: true;
      evidence_refs: string[];
      evidence_verification?: EvidenceVerification;
    }
  | { accepted: false; error: string }
> {
  const { sandbox, signal } = args;
  signal.throwIfAborted();
  // Identity and ownership failures are outside the availability fallback.
  await args.authorize();
  assertSubagentSandboxIdentity(sandbox, args.expectedSandboxIdentity);
  signal.throwIfAborted();
  const refs = [...new Set(args.refs)];
  if (
    args.refs.length > MAX_EVIDENCE_REFS ||
    refs.some((ref) => !ref.trim() || ref.length > 500)
  )
    return {
      accepted: false,
      error: `Use at most ${MAX_EVIDENCE_REFS} nonempty evidence references, each at most 500 characters.`,
    };
  const pathsByRef = new Map(
    refs.flatMap((ref) => {
      const path = evidenceFilePath(ref);
      return path ? [[ref, path] as const] : [];
    }),
  );
  if (pathsByRef.size === 0) return { accepted: true, evidence_refs: refs };
  const paths = [...new Set(pathsByRef.values())];
  const checkAbort = new AbortController();
  const abort = () => checkAbort.abort();
  signal.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, EVIDENCE_CHECK_TIMEOUT_MS);
  const states = new Map<string, FileState>();
  const partialStates: FileState[] = paths.map(() => "unavailable");
  try {
    const fallback = new Promise<FileState[]>((resolve) => {
      checkAbort.signal.addEventListener(
        "abort",
        () => resolve(partialStates),
        { once: true },
      );
    });
    if (signal.aborted) abort();
    const results = await Promise.race([
      checkFiles(sandbox, paths, checkAbort.signal, partialStates),
      fallback,
    ]);
    paths.forEach((path, index) => states.set(path, results[index]));
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
  }
  signal.throwIfAborted();
  await args.authorize();
  signal.throwIfAborted();
  assertSubagentSandboxIdentity(sandbox, args.expectedSandboxIdentity);
  const refsWithState = (state: FileState) =>
    refs.filter((ref) => states.get(pathsByRef.get(ref) ?? "") === state);
  if (refsWithState("forbidden").length) {
    return {
      accepted: false,
      error:
        "Evidence access was denied in the authorized sandbox. Remove the inaccessible reference or supply evidence you are authorized to read; no attachment was accepted.",
    };
  }
  const missing = refsWithState("missing");
  if (missing.length)
    return {
      accepted: false,
      error: `Evidence references do not identify existing files in the current sandbox: ${missing.join(", ")}. Correct the paths or save the missing captures, then submit again.`,
    };
  const unavailable = refsWithState("unavailable");
  const warning = unavailable.length
    ? "Some saved evidence could not be checked because the sandbox metadata service was unavailable. The result is preserved, but those references are not attached as verified evidence. Retry them in a follow-up using the saved unverified references; existence checks do not establish vulnerability validity."
    : undefined;
  return {
    accepted: true,
    evidence_refs: refs.filter((ref) => !unavailable.includes(ref)),
    evidence_verification: {
      checked_refs: refsWithState("exists"),
      unavailable_refs: unavailable,
      ...(warning ? { warning } : {}),
    },
  };
}

export async function verifyResultEvidence(
  args: Omit<Parameters<typeof verifyEvidenceReferences>[0], "refs"> & {
    result: SubagentStructuredResult;
  },
): Promise<
  | { accepted: true; result: CheckedSubagentResult }
  | { accepted: false; error: string }
> {
  const { result } = args;
  const coverage = "coverage" in result ? result.coverage : undefined;
  const checked = await verifyEvidenceReferences({
    ...args,
    refs: [
      ...result.evidence_refs,
      ...(coverage ?? []).flatMap((entry) => entry.evidence_refs),
    ],
  });
  if (!checked.accepted) return checked;
  const retained = (refs: string[]) =>
    [...new Set(refs)].filter((ref) => checked.evidence_refs.includes(ref));
  return {
    accepted: true,
    result: {
      ...result,
      evidence_refs: retained(result.evidence_refs),
      ...(coverage
        ? {
            coverage: coverage.map((entry) => ({
              ...entry,
              evidence_refs: retained(entry.evidence_refs),
            })),
          }
        : {}),
      ...(checked.evidence_verification
        ? { evidence_verification: checked.evidence_verification }
        : {}),
    },
  };
}

export function evidenceWarningText(result: {
  evidence_verification?: EvidenceVerification;
}): string | undefined {
  const verification = result.evidence_verification;
  if (!verification?.warning) return undefined;
  return `Evidence verification warning: ${verification.warning}\n\nUnverified references saved for a follow-up:\n${verification.unavailable_refs.map((ref) => `- ${JSON.stringify(ref)}`).join("\n")}`;
}
