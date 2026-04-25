import { Sandbox, CommandExitError } from "@e2b/code-interpreter";
import { RetryableError, getWritable } from "workflow";
import type { UIMessage, UIMessageChunk, UIMessagePart } from "ai";
import {
  saveMessage,
  setActiveWorkflowRun,
  updateChat,
} from "@/lib/db/actions";

const SANDBOX_TIMEOUT_MS = 60 * 60 * 1000;
const SANDBOX_TEMPLATE = process.env.E2B_TEMPLATE || "terminal-agent-sandbox";

/**
 * Surface a fatal workflow error to the client by writing an AI SDK
 * `error` UI chunk to the default writable stream and closing it. Without
 * this, a workflow that aborts before any chunk is produced leaves the
 * HTTP SSE response hanging on the client.
 */
export async function emitWorkflowError(args: {
  errorText: string;
}): Promise<void> {
  "use step";
  const writer = getWritable<UIMessageChunk>().getWriter();
  try {
    await writer.write({ type: "error", errorText: args.errorText });
    await writer.close();
  } catch {
    // best-effort
  } finally {
    try {
      writer.releaseLock();
    } catch {
      // already released
    }
  }
}

/**
 * Persist the final assistant message produced by the workflow run, then
 * mark the chat with its finish reason. Best-effort: errors are logged to
 * the workflow stream but do not fail the workflow.
 */
export async function saveAssistantMessageStep(args: {
  chatId: string;
  userId: string;
  message: {
    id: string;
    role: "assistant";
    parts: UIMessagePart<any, any>[];
  };
  model?: string;
  finishReason?: string;
}): Promise<{ saved: boolean }> {
  "use step";
  try {
    await saveMessage({
      chatId: args.chatId,
      userId: args.userId,
      message: args.message,
      model: args.model,
      finishReason: args.finishReason,
    });
    if (args.finishReason) {
      await updateChat({
        chatId: args.chatId,
        finishReason: args.finishReason,
      });
    }
    await setActiveWorkflowRun({ chatId: args.chatId, runId: null });
    return { saved: true };
  } catch (error) {
    console.error("[workflow] saveAssistantMessageStep failed", error);
    try {
      await setActiveWorkflowRun({ chatId: args.chatId, runId: null });
    } catch {
      // ignore
    }
    return { saved: false };
  }
}

/**
 * Clear the active workflow run id without saving a message. Used by the
 * workflow's catch handler so a refresh after a failed run doesn't try to
 * reattach to a dead stream.
 */
export async function clearActiveWorkflowRunStep(args: {
  chatId: string;
}): Promise<void> {
  "use step";
  await setActiveWorkflowRun({ chatId: args.chatId, runId: null });
}

async function connect(sandboxId: string): Promise<Sandbox> {
  try {
    const sbx = await Sandbox.connect(sandboxId);
    await sbx.setTimeout(SANDBOX_TIMEOUT_MS);
    return sbx;
  } catch (error) {
    throw new RetryableError(
      `Failed to connect to sandbox ${sandboxId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { retryAfter: "10s" },
    );
  }
}

export async function startSandbox(args: {
  userId: string;
  chatId: string;
}): Promise<{ sandboxId: string }> {
  "use step";
  const sbx = await Sandbox.create(SANDBOX_TEMPLATE, {
    timeoutMs: SANDBOX_TIMEOUT_MS,
    metadata: {
      userId: args.userId,
      chatId: args.chatId,
      origin: "workflow",
    },
  });
  return { sandboxId: sbx.sandboxId };
}

export async function killSandbox(args: {
  sandboxId: string;
}): Promise<{ killed: boolean }> {
  "use step";
  try {
    await Sandbox.kill(args.sandboxId);
    return { killed: true };
  } catch {
    return { killed: false };
  }
}

/**
 * Output shape mirrors the existing `run_terminal_cmd` tool so the
 * ComputerSidebar (`extractSidebarContentFromMessage`) can read
 * `part.output.result.{output,stdout,stderr}` without changes.
 */
export async function runCommandStep(args: {
  sandboxId: string;
  command: string;
  timeoutSeconds: number;
}): Promise<{
  result: {
    exitCode: number;
    stdout: string;
    stderr: string;
    output: string;
    truncated: boolean;
  };
}> {
  "use step";
  const sbx = await connect(args.sandboxId);
  let raw: { stdout?: string; stderr?: string; exitCode?: number };
  try {
    raw = await sbx.commands.run(args.command, {
      timeoutMs: args.timeoutSeconds * 1000,
    });
  } catch (err) {
    // E2B throws CommandExitError on non-zero exit. Treat that as a
    // *result*, not a failure — the agent and the UI need to see the
    // failing command's stdout/stderr (e.g. nmap "Couldn't open a raw
    // socket" lives in stderr). For other thrown errors (timeout, network
    // glitch, sandbox died) we still want them to propagate.
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
  const cap = 50_000;
  const stdout = (raw.stdout ?? "").slice(0, cap);
  const stderr = (raw.stderr ?? "").slice(0, cap);
  return {
    result: {
      exitCode: raw.exitCode ?? 0,
      stdout,
      stderr,
      output: stdout + (stderr ? `\n${stderr}` : ""),
      truncated:
        (raw.stdout?.length ?? 0) > cap || (raw.stderr?.length ?? 0) > cap,
    },
  };
}

function buildAsyncWrapper(
  userCmd: string,
  outputFile: string,
  handle: string,
) {
  const inner = `${userCmd} > ${outputFile} 2>&1; echo $? > ${outputFile}.exit`;
  const quoted = JSON.stringify(inner);
  return `mkdir -p $(dirname ${outputFile}) && nohup bash -lc ${quoted} > /dev/null 2>&1 & echo $! > /tmp/${handle}.pid; disown`;
}

export async function startCommandAsync(args: {
  sandboxId: string;
  command: string;
  outputFile: string;
}): Promise<{
  result: { handle: string; outputFile: string; output: string };
}> {
  "use step";
  const sbx = await connect(args.sandboxId);
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

export async function pollCommandAsync(args: {
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
  const sbx = await connect(args.sandboxId);
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

export async function readFileStep(args: {
  sandboxId: string;
  path: string;
  maxBytes: number;
}): Promise<{ content: string; bytes: number; truncated: boolean }> {
  "use step";
  const sbx = await connect(args.sandboxId);
  const escapedPath = JSON.stringify(args.path);
  const result = await sbx.commands.run(
    `head -c ${args.maxBytes} ${escapedPath}`,
    { timeoutMs: 30_000 },
  );
  const sizeRes = await sbx.commands.run(`wc -c < ${escapedPath}`, {
    timeoutMs: 5_000,
  });
  const bytes = Number((sizeRes.stdout ?? "0").trim()) || 0;
  const content = result.stdout ?? "";
  return {
    content,
    bytes,
    truncated: bytes > args.maxBytes,
  };
}

export async function writeFileStep(args: {
  sandboxId: string;
  path: string;
  content: string;
}): Promise<{ bytes: number }> {
  "use step";
  const sbx = await connect(args.sandboxId);
  await sbx.files.write(args.path, args.content);
  return { bytes: Buffer.byteLength(args.content, "utf8") };
}
