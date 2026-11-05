export type RelayFrame = {
  image: string;
  width: number;
  height: number;
  capturedAt: number;
  browserSessionName: string;
};

/** Fetch streaming permits a bearer header without putting grants in URLs. */
export async function readBrowserRelay(
  url: string,
  grant: string,
  signal: AbortSignal,
  onFrame: (frame: RelayFrame) => void,
  onReady: () => void,
) {
  const connection = new AbortController();
  const connectionSignal = AbortSignal.any([signal, connection.signal]);
  let idleTimer: ReturnType<typeof setTimeout>;
  const resetDeadline = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => connection.abort(), 5000);
  };
  resetDeadline();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${url}/frames`, {
      headers: { Authorization: `Bearer ${grant}` },
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: connectionSignal,
    });
    if (!response.ok || !response.body)
      throw new Error("Browser stream unavailable");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!connectionSignal.aborted) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Browser stream disconnected");
      resetDeadline();
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!line.startsWith("data: ")) continue;
        const message = JSON.parse(line.slice(6));
        if (message.type === "ready") onReady();
        else if (
          message.type === "frame" &&
          message.frame &&
          typeof message.frame.image === "string" &&
          /^data:image\/(jpeg|png);base64,/.test(message.frame.image) &&
          message.frame.image.length <= 900_100 &&
          Number.isFinite(message.frame.width) &&
          Number.isFinite(message.frame.height) &&
          typeof message.frame.browserSessionName === "string"
        ) {
          onFrame(message.frame as RelayFrame);
        }
      }
      if (buffer.length > 1_000_000) throw new Error("Browser frame too large");
    }
  } finally {
    clearTimeout(idleTimer!);
    connection.abort();
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

export async function sendBrowserRelayInput(
  url: string,
  grant: string,
  sequence: number,
  inputs: unknown[],
) {
  const response = await fetch(`${url}/input`, {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: {
      Authorization: `Bearer ${grant}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sequence, inputs }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Browser input disconnected");
}
