import { webcrypto } from "node:crypto";
import { makeFunctionReference } from "convex/server";

jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("convex/browser", () =>
  jest.requireActual("../../../node_modules/convex/dist/cjs/browser/index.js"),
);
jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    flush: jest.fn(),
  },
}));
const { Response: FetchResponse } = jest.requireActual(
  "next/dist/compiled/@edge-runtime/primitives/fetch",
);
Object.defineProperty(globalThis, "Response", {
  value: FetchResponse,
  configurable: true,
});
Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});

const originalFetch = globalThis.fetch;
const originalUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const originalKey = process.env.CONVEX_SERVICE_ROLE_KEY;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
  else process.env.NEXT_PUBLIC_CONVEX_URL = originalUrl;
  if (originalKey === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
  else process.env.CONVEX_SERVICE_ROLE_KEY = originalKey;
});

it.each(["shared mutation", "another snapshot"])(
  "saves a client snapshot while %s is still waiting for transport",
  async (blockedOperation) => {
    jest.resetModules();
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://fixture.convex.cloud";
    process.env.CONVEX_SERVICE_ROLE_KEY = "synthetic-snapshot-service-key";
    const held = deferred();
    const started = deferred();
    const requests: Array<{ path: string; args: Record<string, unknown> }> = [];
    globalThis.fetch = jest.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const args = body.args[0];
      requests.push({ path: body.path, args });
      if (body.path === "fixture:held" || args.id === "head-message") {
        started.resolve();
        await held.promise;
      }
      return new Response(
        JSON.stringify({ status: "success", value: null, logLines: [] }),
      );
    });
    const { saveMessage } = await import("../actions");
    const { getConvexClient } = await import("../convex-client");
    const head =
      blockedOperation === "shared mutation"
        ? getConvexClient().mutation(
            makeFunctionReference<"mutation">("fixture:held"),
            {},
          )
        : saveMessage({
            chatId: "head-chat",
            userId: "head-user",
            message: { id: "head-message", role: "assistant", parts: [] },
            clientSnapshot: true,
          });
    await started.promise;
    let headSettled = false;
    void head.then(() => {
      headSettled = true;
    });
    const saving = saveMessage({
      chatId: "snapshot-chat",
      userId: "snapshot-user",
      message: {
        id: "snapshot-message",
        role: "assistant",
        parts: [{ type: "text", text: "Saved partial response" }],
      },
      mode: "agent",
      triggerRunId: "snapshot-run",
      clientSnapshot: true,
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // A deadlock guard for this deliberately held transport, not a latency SLA.
      const outcome = await Promise.race([
        saving.then(() => "saved"),
        new Promise<string>((resolve) => {
          deadline = setTimeout(
            () => resolve("blocked by another request"),
            1000,
          );
        }),
      ]);
      expect(outcome).toBe("saved");
      expect(headSettled).toBe(false);
      const snapshot = requests.filter(
        ({ args }) => args.id === "snapshot-message",
      );
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].path).toBe("messages:saveMessage");
      expect(snapshot[0].args).toMatchObject({
        chatId: "snapshot-chat",
        userId: "snapshot-user",
        triggerRunId: "snapshot-run",
        clientSnapshot: true,
      });
    } finally {
      clearTimeout(deadline);
      held.resolve();
      await Promise.all([head, saving]);
    }
  },
);
