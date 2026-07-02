type TriggerStreamRecord = {
  seq_num?: number | string;
  timestamp?: number;
  headers?: Array<[string, string]>;
  body?: string;
};

type TriggerBatchEvent = {
  records?: TriggerStreamRecord[];
};

type ParsedSSEEvent = {
  id?: string;
  event?: string;
  data: string;
};

type TriggerRunStatusResponse = {
  status?: string;
};

type ReadTriggerRunStreamOptions = {
  accessToken: string;
  signal?: AbortSignal;
  timeoutInSeconds?: number;
};

const TRIGGER_API_BASE_URL = "https://api.trigger.dev";
const TRIGGER_VERSION = "4.5.0";
const TRIGGER_API_VERSION = "2025-07-16";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_SEEN_STREAM_IDS = 5_000;
const NON_RETRYABLE_STATUSES = new Set([400, 404, 409, 410, 422]);

class TriggerRealtimeNonRetryableError extends Error {}

const getTriggerStreamHeaders = (
  accessToken: string,
  lastEventId?: string,
  timeoutInSeconds?: number,
): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "trigger-version": TRIGGER_VERSION,
    "x-trigger-api-version": TRIGGER_API_VERSION,
    "x-trigger-client": "browser",
    "x-trigger-realtime-streams-version": "v2",
    "x-trigger-source": "sdk",
  };

  if (lastEventId) headers["Last-Event-ID"] = lastEventId;
  if (timeoutInSeconds !== undefined) {
    headers["Timeout-Seconds"] = timeoutInSeconds.toString();
  }

  return headers;
};

const getTriggerJsonHeaders = (
  accessToken: string,
): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
  "Content-Type": "application/json",
  "trigger-version": TRIGGER_VERSION,
  "x-trigger-api-version": TRIGGER_API_VERSION,
  "x-trigger-client": "browser",
  "x-trigger-realtime-streams-version": "v2",
  "x-trigger-source": "sdk",
});

const linkAbort = (
  parent: AbortSignal | undefined,
  child: AbortController,
): (() => void) => {
  if (!parent) return () => {};
  if (parent.aborted) {
    child.abort();
    return () => {};
  }

  const abort = () => child.abort();
  parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
};

const waitForRetry = (attempt: number, signal: AbortSignal): Promise<void> => {
  const baseDelayMs = Math.min(100 * 2 ** Math.max(0, attempt - 1), 5_000);
  const jitteredDelayMs = baseDelayMs * (0.5 + Math.random() * 0.5);

  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timeoutId = setTimeout(done, jitteredDelayMs);
    function done() {
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
};

const safeParseJSON = (data: string): unknown => {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
};

const createSSEParser = () => {
  let buffer = "";
  let id: string | undefined;
  let event: string | undefined;
  let dataLines: string[] = [];

  const dispatch = (): ParsedSSEEvent | undefined => {
    if (id === undefined && event === undefined && dataLines.length === 0) {
      return undefined;
    }

    const parsedEvent = {
      ...(id !== undefined ? { id } : {}),
      ...(event !== undefined ? { event } : {}),
      data: dataLines.join("\n"),
    };

    id = undefined;
    event = undefined;
    dataLines = [];
    return parsedEvent;
  };

  const processLine = (line: string): ParsedSSEEvent | undefined => {
    const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalizedLine === "") return dispatch();
    if (normalizedLine.startsWith(":")) return undefined;

    const separatorIndex = normalizedLine.indexOf(":");
    const field =
      separatorIndex === -1
        ? normalizedLine
        : normalizedLine.slice(0, separatorIndex);
    const value =
      separatorIndex === -1
        ? ""
        : normalizedLine.slice(separatorIndex + 1).replace(/^ /, "");

    if (field === "data") dataLines.push(value);
    if (field === "event") event = value;
    if (field === "id" && !value.includes("\0")) id = value;

    return undefined;
  };

  return {
    feed(chunk: string): ParsedSSEEvent[] {
      buffer += chunk;
      const events: ParsedSSEEvent[] = [];
      let lineEndIndex = buffer.search(/\r?\n/);

      while (lineEndIndex !== -1) {
        const line = buffer.slice(0, lineEndIndex);
        const newlineLength =
          buffer[lineEndIndex] === "\r" && buffer[lineEndIndex + 1] === "\n"
            ? 2
            : 1;
        buffer = buffer.slice(lineEndIndex + newlineLength);

        const parsedEvent = processLine(line);
        if (parsedEvent) events.push(parsedEvent);
        lineEndIndex = buffer.search(/\r?\n/);
      }

      return events;
    },
    flush(): ParsedSSEEvent[] {
      const events: ParsedSSEEvent[] = [];
      if (buffer.length > 0) {
        const parsedEvent = processLine(buffer);
        if (parsedEvent) events.push(parsedEvent);
        buffer = "";
      }

      const finalEvent = dispatch();
      if (finalEvent) events.push(finalEvent);
      return events;
    },
  };
};

async function* readSSEEvents(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<ParsedSSEEvent> {
  if (!response.body) throw new Error("No Trigger realtime response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSSEParser();

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      for (const event of parser.feed(text)) yield event;
    }

    for (const event of parser.feed(decoder.decode())) yield event;
    for (const event of parser.flush()) yield event;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function retrieveTriggerRunStatus(
  runId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const response = await fetch(
    `${TRIGGER_API_BASE_URL}/api/v1/runs/${encodeURIComponent(runId)}`,
    {
      headers: getTriggerJsonHeaders(accessToken),
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(`Trigger run status request failed: ${response.status}`);
  }

  const run = (await response.json()) as TriggerRunStatusResponse;
  return run.status;
}

export async function* readTriggerRunStream<T>(
  runId: string,
  streamKey: string,
  options: ReadTriggerRunStreamOptions,
): AsyncGenerator<T> {
  const abortController = new AbortController();
  const unlinkAbort = linkAbort(options.signal, abortController);
  let lastEventId: string | undefined;
  let retryCount = 0;
  const seenStreamIds = new Set<string>();

  const rememberSeenStreamId = (id: string) => {
    seenStreamIds.add(id);
    if (seenStreamIds.size <= MAX_SEEN_STREAM_IDS) return;
    const oldestId = seenStreamIds.values().next().value;
    if (oldestId !== undefined) seenStreamIds.delete(oldestId);
  };

  const streamUrl = `${TRIGGER_API_BASE_URL}/realtime/v1/streams/${encodeURIComponent(
    runId,
  )}/${encodeURIComponent(streamKey)}`;

  try {
    while (!abortController.signal.aborted) {
      const fetchAbortController = new AbortController();
      const unlinkFetchAbort = linkAbort(
        abortController.signal,
        fetchAbortController,
      );
      const fetchTimeoutId = setTimeout(
        () => fetchAbortController.abort(),
        FETCH_TIMEOUT_MS,
      );

      try {
        const response = await fetch(streamUrl, {
          headers: getTriggerStreamHeaders(
            options.accessToken,
            lastEventId,
            options.timeoutInSeconds,
          ),
          signal: fetchAbortController.signal,
        });
        clearTimeout(fetchTimeoutId);

        if (!response.ok) {
          if (NON_RETRYABLE_STATUSES.has(response.status)) {
            throw new TriggerRealtimeNonRetryableError(
              `Trigger stream request failed: ${response.status}`,
            );
          }
          retryCount++;
          await waitForRetry(retryCount, abortController.signal);
          continue;
        }

        retryCount = 0;
        const streamVersion = response.headers.get("X-Stream-Version") ?? "v1";

        for await (const event of readSSEEvents(
          response,
          abortController.signal,
        )) {
          if (streamVersion === "v1") {
            if (event.id) lastEventId = event.id;
            yield safeParseJSON(event.data) as T;
            continue;
          }

          if (event.event !== "batch") continue;
          const batch = safeParseJSON(event.data) as TriggerBatchEvent;
          if (!batch || !Array.isArray(batch.records)) continue;

          for (const record of batch.records) {
            if (record.seq_num !== undefined) {
              lastEventId = record.seq_num.toString();
            }

            if (record.headers?.[0]?.[0] === "") continue;

            const parsedBody =
              typeof record.body === "string"
                ? (safeParseJSON(record.body) as { id?: string; data?: T })
                : undefined;

            if (!parsedBody) continue;
            if (parsedBody.id) {
              if (seenStreamIds.has(parsedBody.id)) continue;
              rememberSeenStreamId(parsedBody.id);
            }

            yield parsedBody.data as T;
          }
        }

        return;
      } catch (error) {
        clearTimeout(fetchTimeoutId);
        if (abortController.signal.aborted) return;
        if (error instanceof TriggerRealtimeNonRetryableError) throw error;
        retryCount++;
        await waitForRetry(retryCount, abortController.signal);
      } finally {
        clearTimeout(fetchTimeoutId);
        unlinkFetchAbort();
      }
    }
  } finally {
    abortController.abort();
    unlinkAbort();
  }
}
