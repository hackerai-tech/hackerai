import type { UIMessageStreamWriter } from "ai";
import {
  TRIGGER_CHAT_HEARTBEAT_INTERVAL_MS,
  TRIGGER_CHAT_HEARTBEAT_PART_TYPE,
} from "@/lib/chat/trigger-chat-heartbeat";

type TriggerChatUiStreamPart = Parameters<UIMessageStreamWriter["write"]>[0];

export const withTriggerChatStreamHeartbeat = (
  source: ReadableStream<TriggerChatUiStreamPart>,
  signal: AbortSignal,
): ReadableStream<TriggerChatUiStreamPart> => {
  let reader: ReadableStreamDefaultReader<TriggerChatUiStreamPart> | undefined;
  let stopHeartbeat: (() => void) | undefined;

  return new ReadableStream<TriggerChatUiStreamPart>({
    start(controller) {
      reader = source.getReader();
      let stopped = false;
      const safeEnqueue = (part: TriggerChatUiStreamPart) => {
        try {
          controller.enqueue(part);
        } catch {
          stop();
        }
      };
      const safeClose = () => {
        try {
          controller.close();
        } catch {
          // The consumer may already have canceled the wrapper stream.
        }
      };
      const safeError = (error: unknown) => {
        try {
          controller.error(error);
        } catch {
          // The consumer may already have canceled the wrapper stream.
        }
      };

      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(intervalId);
        signal.removeEventListener("abort", stop);
      };
      stopHeartbeat = stop;

      const intervalId = setInterval(() => {
        if (signal.aborted) {
          stop();
          return;
        }

        safeEnqueue({
          type: TRIGGER_CHAT_HEARTBEAT_PART_TYPE,
          data: { at: Date.now() },
        } as TriggerChatUiStreamPart);
      }, TRIGGER_CHAT_HEARTBEAT_INTERVAL_MS);

      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();

      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader!.read();
            if (done) {
              safeClose();
              return;
            }
            safeEnqueue(value);
          }
        } catch (error) {
          safeError(error);
        } finally {
          stop();
          reader?.releaseLock();
        }
      })();
    },
    cancel(reason) {
      stopHeartbeat?.();
      return reader?.cancel(reason);
    },
  });
};
