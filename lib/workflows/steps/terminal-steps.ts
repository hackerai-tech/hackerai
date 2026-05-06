import { CommandExitError } from "@e2b/code-interpreter";
import {
  parseGuardrailConfig,
  getEffectiveGuardrails,
  checkCommandGuardrails,
} from "@/lib/ai/tools/utils/guardrails";
import { uploadSandboxFileToConvex } from "@/lib/ai/tools/utils/sandbox-file-uploader";
import type { Id } from "@/convex/_generated/dataModel";
import { connectToSandbox } from "./sandbox-connect";

const OUTPUT_CAP = 50_000;

export async function runTerminalCmdStep(args: {
  sandboxId: string;
  command: string;
  is_background: boolean;
  timeout: number;
  guardrailsConfig?: string;
}): Promise<{
  result: {
    output: string;
    exitCode?: number | null;
    error?: string;
    pid?: number;
    truncated?: boolean;
  };
}> {
  "use step";

  const userGuardrailConfig = parseGuardrailConfig(args.guardrailsConfig);
  const effectiveGuardrails = getEffectiveGuardrails(userGuardrailConfig);
  const guardrail = checkCommandGuardrails(args.command, effectiveGuardrails);
  if (!guardrail.allowed) {
    return {
      result: {
        output: "",
        exitCode: 1,
        error: `Command blocked by security guardrail "${guardrail.policyName}": ${guardrail.message}. This command pattern has been blocked for safety. If you believe this is a false positive, the user can adjust guardrail settings.`,
      },
    };
  }

  const sbx = await connectToSandbox(args.sandboxId);

  if (args.is_background) {
    try {
      const exec = await sbx.commands.run(args.command, {
        background: true,
        timeoutMs: 10_000,
      });
      const pid = (exec as { pid?: number }).pid;
      return {
        result: {
          output: `Background process started with PID: ${pid ?? "unknown"}\n`,
          pid,
          exitCode: 0,
        },
      };
    } catch (err) {
      if (err instanceof CommandExitError) {
        return {
          result: {
            output: (err as { stdout?: string }).stdout ?? "",
            exitCode: (err as { exitCode?: number }).exitCode ?? 1,
            error: (err as { stderr?: string }).stderr ?? String(err.message),
          },
        };
      }
      throw err;
    }
  }

  const timeoutSeconds = Math.min(Math.max(args.timeout, 1), 600);
  let raw: { stdout?: string; stderr?: string; exitCode?: number };
  try {
    raw = await sbx.commands.run(args.command, {
      timeoutMs: timeoutSeconds * 1000,
    });
  } catch (err) {
    if (err instanceof CommandExitError) {
      raw = {
        stdout: (err as { stdout?: string }).stdout ?? "",
        stderr:
          (err as { stderr?: string }).stderr ?? String(err.message ?? err),
        exitCode: (err as { exitCode?: number }).exitCode ?? 1,
      };
    } else {
      throw err;
    }
  }

  const stdoutFull = raw.stdout ?? "";
  const stderrFull = raw.stderr ?? "";
  const stdout = stdoutFull.slice(0, OUTPUT_CAP);
  const stderr = stderrFull.slice(0, OUTPUT_CAP);
  const truncated =
    stdoutFull.length > OUTPUT_CAP || stderrFull.length > OUTPUT_CAP;
  const output = stdout + (stderr ? `\n${stderr}` : "");

  return {
    result: {
      output,
      exitCode: raw.exitCode ?? 0,
      truncated,
    },
  };
}

export interface UploadedFileMetadata {
  fileId: Id<"files">;
  name: string;
  mediaType: string;
  s3Key?: string;
  storageId?: Id<"_storage">;
}

export async function getTerminalFilesStep(args: {
  sandboxId: string;
  files: string[];
  userId: string;
}): Promise<{
  result: string;
  files: { path: string }[];
  uploaded: UploadedFileMetadata[];
}> {
  "use step";
  try {
    const sbx = await connectToSandbox(args.sandboxId);
    const providedFiles: { path: string }[] = [];
    const blockedFiles: { path: string; reason: string }[] = [];
    const uploaded: UploadedFileMetadata[] = [];

    for (const originalPath of args.files) {
      const pathsToTry: string[] = [];
      if (originalPath.startsWith("/")) {
        pathsToTry.push(originalPath);
      } else {
        pathsToTry.push(`/home/user/${originalPath}`);
        pathsToTry.push(originalPath);
      }

      let fileProcessed = false;
      let lastError: string | null = null;

      for (const filePath of pathsToTry) {
        try {
          const saved = await uploadSandboxFileToConvex({
            sandbox: sbx,
            userId: args.userId,
            fullPath: filePath,
            skipTokenValidation: true,
          });
          const metadata: UploadedFileMetadata = {
            fileId: saved.fileId,
            name: saved.name,
            mediaType: saved.mediaType,
            s3Key: saved.s3Key,
            storageId: saved.storageId,
          };
          uploaded.push(metadata);
          providedFiles.push({ path: originalPath });
          fileProcessed = true;
          break;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      }

      if (!fileProcessed) {
        blockedFiles.push({
          path: originalPath,
          reason: `File not found or upload failed: ${
            lastError ?? "Unknown error"
          }`,
        });
      }
    }

    let result = "";
    if (providedFiles.length > 0) {
      result += `Successfully provided ${providedFiles.length} file(s) to the user`;
    }
    if (blockedFiles.length > 0) {
      const details = blockedFiles
        .map((f) => `${f.path}: ${f.reason}`)
        .join("; ");
      result +=
        (result ? ". " : "") +
        `${blockedFiles.length} file(s) could not be retrieved: ${details}`;
    }

    return {
      result: result || "No files were retrieved",
      files: providedFiles,
      uploaded,
    };
  } catch (error) {
    return {
      result: `Error providing files: ${
        error instanceof Error ? error.message : String(error)
      }`,
      files: [],
      uploaded: [],
    };
  }
}

// ── Long-running async command pair (workflow-only) ─────────────────────

function buildAsyncWrapper(
  userCmd: string,
  outputFile: string,
  handle: string,
) {
  const inner = `${userCmd} > ${outputFile} 2>&1; echo $? > ${outputFile}.exit`;
  const quoted = JSON.stringify(inner);
  return `mkdir -p $(dirname ${outputFile}) && nohup bash -lc ${quoted} > /dev/null 2>&1 & echo $! > /tmp/${handle}.pid; disown`;
}

export async function startCommandAsyncStep(args: {
  sandboxId: string;
  command: string;
  outputFile: string;
}): Promise<{
  result: { handle: string; outputFile: string; output: string };
}> {
  "use step";
  const sbx = await connectToSandbox(args.sandboxId);
  const handle = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const wrapped = buildAsyncWrapper(args.command, args.outputFile, handle);
  await sbx.commands.run(wrapped, { timeoutMs: 10_000 });
  return {
    result: {
      handle,
      outputFile: args.outputFile,
      output: `[started in background]\nhandle=${handle}\noutput_file=${args.outputFile}`,
    },
  };
}

function buildPollScript(
  handle: string,
  outputFile: string,
  tailLines: number,
) {
  return [
    `PID_FILE=/tmp/${handle}.pid`,
    `EXIT_FILE=${outputFile}.exit`,
    `PID=$(cat "$PID_FILE" 2>/dev/null || echo "")`,
    `if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then`,
    `  echo "STATUS=running"`,
    `else`,
    `  echo "STATUS=done"`,
    `  if [ -f "$EXIT_FILE" ]; then echo "EXIT=$(cat "$EXIT_FILE")"; fi`,
    `fi`,
    `echo "BYTES=$(wc -c < ${outputFile} 2>/dev/null || echo 0)"`,
    `echo "----TAIL----"`,
    `tail -n ${tailLines} ${outputFile} 2>/dev/null || true`,
  ].join("\n");
}

export async function pollCommandAsyncStep(args: {
  sandboxId: string;
  handle: string;
  outputFile: string;
  tailLines: number;
}): Promise<{
  done: boolean;
  exitCode?: number;
  tail: string;
  bytes: number;
}> {
  "use step";
  const sbx = await connectToSandbox(args.sandboxId);
  const script = buildPollScript(args.handle, args.outputFile, args.tailLines);
  const result = await sbx.commands.run(script, { timeoutMs: 15_000 });
  const out = result.stdout ?? "";
  const tailIdx = out.indexOf("----TAIL----\n");
  const head = tailIdx >= 0 ? out.slice(0, tailIdx) : out;
  const tail = tailIdx >= 0 ? out.slice(tailIdx + "----TAIL----\n".length) : "";
  const status = /STATUS=(\w+)/.exec(head)?.[1] ?? "running";
  const exitCode = Number(/EXIT=(-?\d+)/.exec(head)?.[1]);
  const bytes = Number(/BYTES=(\d+)/.exec(head)?.[1] ?? 0);
  return {
    done: status === "done",
    exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
    tail,
    bytes,
  };
}
