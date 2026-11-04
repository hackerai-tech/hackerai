import WebSocket from "ws";
import { z } from "zod";

// The initial rollout opens fresh public demo pages. It deliberately does not
// copy authenticated cookies, storage, or form values into another provider.
const targets: Record<
  string,
  { widget: string; type?: string; proxy?: boolean }
> = {
  "https://www.google.com/recaptcha/api2/demo": {
    widget: ".g-recaptcha",
    type: "recaptcha",
  },
  "https://accounts.hcaptcha.com/demo": { widget: ".h-captcha", proxy: true },
  "https://2captcha.com/demo/cloudflare-turnstile": {
    widget: ".cf-turnstile",
    type: "cloudflare",
  },
};

export function isBrowserlessFallbackTarget(url: string) {
  return Object.hasOwn(targets, url);
}

export type BrowserlessSession = {
  socket: WebSocket;
  expiresAt: number;
  close: () => Promise<void>;
};

const responseSchema = z.object({
  data: z
    .object({
      solve: z.object({ found: z.boolean(), solved: z.boolean() }).nullish(),
      reconnect: z
        .object({ browserWSEndpoint: z.string().max(4096) })
        .nullish(),
    })
    .nullish(),
});

/** One allocation; no retries and no returned provider credentials or errors. */
export async function openBrowserlessFallback(
  url: string,
  key: string,
  signal: AbortSignal,
): Promise<BrowserlessSession> {
  if (!isBrowserlessFallbackTarget(url) || !/^[A-Za-z0-9_-]{32,128}$/.test(key))
    throw new Error("Browserless fallback unavailable.");
  const target = targets[url];
  const expiresAt = Date.now() + 110_000;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(110_000)]);
  const endpoint = new URL(
    "https://production-sfo.browserless.io/stealth/bql?timeout=110000",
  );
  if (target.proxy) {
    endpoint.searchParams.set("proxy", "residential");
    endpoint.searchParams.set("proxyCountry", "us");
    endpoint.searchParams.set("proxySticky", "true");
  }
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      // agent-browser disconnects from external CDP browsers on close. Explicitly
      // terminate our hosted browser as well, without keeping its reconnect TTL.
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({ id: 2147483646, method: "Browser.close" }),
        );
      const stop = setTimeout(() => {
        socket?.terminate();
        resolve();
      }, 1000);
      socket.once("close", () => {
        clearTimeout(stop);
        resolve();
      });
    }));
  const onAbort = () => {
    void close();
  };
  try {
    signal.throwIfAborted();
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: deadline,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation Fallback {
        goto(url: ${JSON.stringify(url)}) { status }
        widget: waitForSelector(selector: ${JSON.stringify(target.widget)}, timeout: 10000) { time }
        solve(${target.type ? `type: ${target.type}, ` : ""}wait: true, timeout: 90000) { found solved }
        reconnect(timeout: 15000) { browserWSEndpoint }
      }`,
      }),
    });
    if (!response.ok) throw new Error();
    const body = responseSchema.parse(await response.json());
    const address = body.data?.reconnect?.browserWSEndpoint;
    if (!address) throw new Error();
    const remote = new URL(address);
    if (
      remote.protocol !== "wss:" ||
      remote.hostname !== "production-sfo.browserless.io" ||
      remote.port ||
      remote.username ||
      remote.password ||
      remote.hash
    )
      throw new Error();
    // Some reconnect responses include the account token. Keep it entirely in
    // worker memory and use the authenticated header instead of forwarding it.
    remote.searchParams.delete("token");
    deadline.throwIfAborted();
    socket = new WebSocket(remote, {
      headers: { Authorization: `Bearer ${key}` },
      handshakeTimeout: 8000,
      maxPayload: 8 * 1024 * 1024,
    });
    socket.on("error", () => {}); // Never log credential-bearing provider errors.
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(onAbort, Math.max(1, expiresAt - Date.now()));
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", () =>
        reject(new Error("Browserless connection failed.")),
      );
      socket!.once("close", () =>
        reject(new Error("Browserless connection ended.")),
      );
    });
    deadline.throwIfAborted();
    if (!body.data?.solve?.found || !body.data.solve.solved) throw new Error();
    return { socket, expiresAt, close };
  } catch {
    await close();
    signal.throwIfAborted();
    throw new Error("Browserless fallback failed; do not retry this run.");
  }
}
