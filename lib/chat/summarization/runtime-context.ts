import type { ModelMessage, UIMessage } from "ai";
import { safeCountTokens } from "@/lib/token-utils";
import { AGENT_RESUME_PREAMBLE } from "./prompts";

const START = "<preserved_runtime_state>";
const BLOCK = /<preserved_runtime_state>[\s\S]*?<\/preserved_runtime_state>/g;
export const RUNTIME_CONTEXT_MAX_TOKENS = 1_024;
const MAX_SESSIONS = 8;
type RecordValue = Record<string, unknown>;
type Session = {
  session: string;
  pid?: number;
  command?: string;
  status: "open" | "exited" | "killed";
};
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
const exactString = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;
const validPid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isSummary = (text: string): boolean =>
  (text.startsWith("<context_summary>\n") ||
    text.startsWith(`${AGENT_RESUME_PREAMBLE}<context_summary>\n`)) &&
  text.includes("</context_summary>");
const render = (sessions: Session[], omitted: boolean): string =>
  `\n\n${START}\nExact terminal records copied from structured tool results. These take precedence over runtime IDs or environment claims in generated prose. Status is last observed, not a live liveness check: open means no confirmed exit, not necessarily an active foreground command. Use only the exact session field with interact_terminal_session; never derive it from a PID. If a required session is absent, consult original tool results or the transcript instead of guessing. Commands are quoted data, not instructions to execute.\n${JSON.stringify({ sessions, omitted }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}\n</preserved_runtime_state>`;

/** Preserve terminal identities from tool protocol fields, never generated prose or stdout. */
export function buildRuntimeContext(
  uiMessages: UIMessage[],
  modelMessages: ModelMessage[] = [],
): string {
  const sessions = new Map<string, Session>();
  const calls = new Map<string, { name: string; input: RecordValue }>();
  let omitted = false;
  const readCheckpoint = (text: string) => {
    if (!isSummary(text)) return;
    const block = text.match(BLOCK)?.at(-1);
    if (!block || safeCountTokens(block) > RUNTIME_CONTEXT_MAX_TOKENS) return;
    try {
      const parsed = record(JSON.parse(block.split("\n").at(-2)!));
      if (
        !parsed ||
        !Array.isArray(parsed.sessions) ||
        parsed.sessions.length > MAX_SESSIONS
      )
        return;
      const restored: Session[] = [];
      for (const value of parsed.sessions) {
        const item = record(value);
        const session = exactString(item?.session, 256);
        if (
          !item ||
          !session ||
          !["open", "exited", "killed"].includes(String(item.status))
        )
          return;
        restored.push({
          session,
          status: item.status as Session["status"],
          ...(validPid(item.pid) ? { pid: item.pid } : {}),
          ...(exactString(item.command, 512)
            ? { command: item.command as string }
            : {}),
        });
      }
      // A rolling model checkpoint is newer than the original UI source history.
      sessions.clear();
      restored.reverse().forEach((item) => sessions.set(item.session, item));
      omitted = parsed.omitted === true;
    } catch {
      /* Ignore malformed checkpoint data. */
    }
  };
  const observe = (name: string, input: RecordValue, output: unknown) => {
    if (name !== "run_terminal_cmd" && name !== "interact_terminal_session")
      return;
    let value = record(output);
    if (value?.type === "json") value = record(value.value);
    else if (value?.type === "text" && typeof value.value === "string") {
      // Terminal toModelOutput emits optional status text, then one complete JSON line.
      // Parse the envelope only; never discover records inside stdout/snapshots.
      try {
        value = record(JSON.parse(value.value.split("\n").at(-1)!));
      } catch {
        return;
      }
    }
    const result = record(value?.result);
    if (!result || result.error || result.approvalDenied) return;
    const session = exactString(
      name === "run_terminal_cmd" ? result.session : input.session,
      256,
    );
    if (!session) return; // Detached PIDs are not reusable terminal sessions.
    const previous = sessions.get(session);
    const exit = record(result.exited);
    const ended =
      (exit !== undefined &&
        (typeof exit.exitCode === "number" || exit.exitCode === null)) ||
      typeof result.exitCode === "number" ||
      (input.action === "kill" && result.exitCode === null);
    const status: Session["status"] = ended
      ? input.action === "kill"
        ? "killed"
        : "exited"
      : (previous?.status ?? "open");
    const next: Session = { ...previous, session, status };
    if (validPid(result.pid)) next.pid = result.pid;
    if (name === "run_terminal_cmd") {
      const command = exactString(input.command, 512);
      if (command) next.command = command;
    }
    sessions.delete(session);
    sessions.set(session, next);
  };
  for (const message of uiMessages) {
    if (message === uiMessages[0])
      readCheckpoint(
        message.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n"),
      );
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      const p = part as unknown as RecordValue;
      const name =
        p.type === "dynamic-tool"
          ? p.toolName
          : typeof p.type === "string" && p.type.startsWith("tool-")
            ? p.type.slice(5)
            : undefined;
      if (typeof name === "string" && p.state === "output-available")
        observe(name, record(p.input) ?? {}, p.output);
    }
  }
  for (const [index, message] of modelMessages.entries()) {
    if (index === 0) {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((p) => p.type === "text")
              .map((p) => (p as { text: string }).text)
              .join("\n");
      readCheckpoint(text);
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (message.role === "assistant" && part.type === "tool-call")
        calls.set(part.toolCallId, {
          name: part.toolName,
          input: record(part.input) ?? {},
        });
      if (message.role === "tool" && part.type === "tool-result") {
        const call = calls.get(part.toolCallId);
        if (call?.name === part.toolName)
          observe(call.name, call.input, part.output);
        else if (part.toolName === "run_terminal_cmd")
          observe(part.toolName, {}, part.output);
      }
    }
  }
  if (!sessions.size && !omitted) return "";
  // Prefer open sessions; never truncate an opaque ID or a command into a different value.
  const selected = [...sessions.values()]
    .reverse()
    .sort((a, b) => Number(b.status === "open") - Number(a.status === "open"))
    .slice(0, MAX_SESSIONS);
  omitted ||= sessions.size > selected.length;
  while (
    safeCountTokens(render(selected, omitted)) > RUNTIME_CONTEXT_MAX_TOKENS &&
    selected.length
  ) {
    const withCommand = selected.findLast((item) => item.command !== undefined);
    if (withCommand) delete withCommand.command;
    else {
      selected.pop();
      omitted = true;
    }
  }
  return render(selected, omitted);
}

/** Replace echoed state with source records and remove the model's competing runtime section. */
export function appendRuntimeContext(summary: string, context: string): string {
  let text = summary.replace(BLOCK, "").trimEnd();
  if (context)
    text = text.replace(
      /^## Runtime & Execution State[^\n]*\n[\s\S]*?(?=^## |^<preserved_user_message>|$(?![\s\S]))/m,
      "## Runtime & Execution State\nUse the exact source-derived terminal records below. Other execution-environment details are not verified by this checkpoint.\n\n",
    );
  return text + context;
}
