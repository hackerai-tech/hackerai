/** Read the exact Trigger UI stream used by HackerAI's Agent transport. */
import { createInterface } from "node:readline";
import { readTriggerRunStream } from "../../../lib/chat/trigger-browser-realtime";
import { AGENT_UI_STREAM_ID } from "../../../trigger/stream-ids";

type StartRecord = {
  runId: string;
  publicAccessToken: string;
  limitSeconds: number;
};

async function main() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done || first.value.length > 16384) throw new Error("InvalidInput");
  const start = JSON.parse(first.value) as StartRecord;
  if (
    typeof start.runId !== "string" ||
    typeof start.publicAccessToken !== "string" ||
    !Number.isInteger(start.limitSeconds) ||
    start.limitSeconds < 60 ||
    start.limitSeconds > 21600
  ) {
    throw new Error("InvalidInput");
  }

  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    (start.limitSeconds + 60) * 1000,
  );
  let tail: ReturnType<typeof setTimeout> | undefined;
  let agentWork = false;
  let finish = false;
  let autoContinue = false;
  let eventCount = 0;

  try {
    for await (const value of readTriggerRunStream<unknown>(
      start.runId,
      AGENT_UI_STREAM_ID,
      {
        accessToken: start.publicAccessToken,
        signal: controller.signal,
        timeoutInSeconds: 300,
        refreshAccessToken: async () => {
          process.stdout.write('{"event":"refresh"}\n');
          const next = await lines.next();
          if (next.done || next.value.length > 16384) {
            throw new Error("TokenRefreshUnavailable");
          }
          const refreshed = JSON.parse(next.value) as { token?: unknown };
          if (typeof refreshed.token !== "string" || !refreshed.token) {
            throw new Error("TokenRefreshUnavailable");
          }
          return refreshed.token;
        },
      },
    )) {
      if (typeof value !== "object" || value === null || !("type" in value)) {
        continue;
      }
      const type = (value as { type?: unknown }).type;
      eventCount++;
      if (
        type === "text-delta" ||
        type === "tool-input-available" ||
        type === "tool-output-available"
      ) {
        agentWork = true;
      }
      if (type === "data-auto-continue") autoContinue = true;
      if (type === "finish" && !finish) {
        finish = true;
        tail = setTimeout(() => controller.abort(), 2000);
      }
      if (type === "abort" || type === "error") controller.abort();
    }
    process.stdout.write(
      JSON.stringify({
        event: "result",
        agentWork,
        finish,
        autoContinue,
        eventCount,
      }) + "\n",
    );
  } finally {
    clearTimeout(deadline);
    if (tail) clearTimeout(tail);
    input.close();
  }
}

void main().catch((error: unknown) => {
  const errorClass = error instanceof Error ? error.name : "UnknownError";
  process.stdout.write(JSON.stringify({ event: "error", errorClass }) + "\n");
  process.exitCode = 1;
});
