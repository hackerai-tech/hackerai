"use client";

import { useCallback, useEffect, useState } from "react";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";

import { readTriggerRunStream } from "@/lib/chat/trigger-browser-realtime";

type TokenResponse = {
  accessToken: string;
  runId: string;
  streamId: string;
};

type RealtimeState = "idle" | "connecting" | "live" | "complete" | "error";

const requestToken = async (
  subagentId: string,
  signal: AbortSignal,
): Promise<TokenResponse> => {
  const response = await fetch(
    `/api/subagents/${encodeURIComponent(subagentId)}/token`,
    { method: "POST", signal, cache: "no-store" },
  );
  if (!response.ok) throw new Error("Unable to authorize child stream");
  return (await response.json()) as TokenResponse;
};

const toReadableStream = (
  iterable: AsyncGenerator<unknown>,
): ReadableStream<UIMessageChunk> =>
  new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      const next = await iterable.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value as UIMessageChunk);
    },
    async cancel() {
      await iterable.return(undefined);
    },
  });

export const useSubagentRealtime = ({
  subagentId,
  enabled,
}: {
  subagentId?: string;
  enabled: boolean;
}) => {
  const [message, setMessage] = useState<UIMessage | null>(null);
  const [state, setState] = useState<RealtimeState>("idle");
  const [retryKey, setRetryKey] = useState(0);
  const retry = useCallback(() => setRetryKey((value) => value + 1), []);

  useEffect(() => {
    setMessage(null);
    if (!subagentId || !enabled) {
      setState("idle");
      return;
    }

    const abort = new AbortController();
    let mounted = true;
    setState("connecting");

    void (async () => {
      try {
        const token = await requestToken(subagentId, abort.signal);
        const chunks = readTriggerRunStream<unknown>(
          token.runId,
          token.streamId,
          {
            accessToken: token.accessToken,
            refreshAccessToken: async () =>
              (await requestToken(subagentId, abort.signal)).accessToken,
            signal: abort.signal,
            timeoutInSeconds: 120,
          },
        );
        const messages = readUIMessageStream({
          stream: toReadableStream(chunks),
          terminateOnError: true,
        });
        for await (const nextMessage of messages) {
          if (!mounted) return;
          setState("live");
          setMessage(nextMessage);
        }
        if (mounted) setState("complete");
      } catch {
        if (mounted && !abort.signal.aborted) setState("error");
      }
    })();

    return () => {
      mounted = false;
      abort.abort();
    };
  }, [enabled, retryKey, subagentId]);

  return { message, state, retry };
};
