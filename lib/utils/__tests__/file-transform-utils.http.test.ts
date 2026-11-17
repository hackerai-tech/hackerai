/** @jest-environment node */
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { processMessageFiles } from "../file-transform-utils";

jest.mock("server-only", () => ({}), { virtual: true });
const mockConvexAction = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: jest.fn(() => ({
    action: mockConvexAction,
    query: jest.fn(async () => []),
  })),
}));

const STORAGE_ORIGIN = "https://storage.example";
const SIGNATURE = "fixture-signature-value";
const VALID_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
  "base64",
);
const CLOSE_DEADLINE_MS = 2000;

// Each route flushes its headers; rejection routes then leave the body open
// indefinitely so only client-side cleanup can release the connection.
const routes: Record<string, (res: ServerResponse) => void> = {
  "/oversized.png": (res) => {
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(40 * 1024 * 1024),
    });
    res.write(VALID_PNG_BYTES.subarray(0, 8));
  },
  "/unavailable.png": (res) => {
    res.writeHead(503, { "content-type": "text/plain" });
    res.write("temporarily unavailable");
  },
  "/valid.png": (res) => {
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(VALID_PNG_BYTES.byteLength),
    });
    res.end(VALID_PNG_BYTES);
  },
};

const withStorageFixture = async (
  run: (responseClosed: Promise<void>) => Promise<void>,
) => {
  let markClosed!: () => void;
  const responseClosed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const server = createServer((req, res) => {
    res.on("close", markClosed);
    const route = routes[new URL(req.url ?? "/", "http://fixture").pathname];
    if (route) route(res);
    else res.writeHead(404).end();
  });
  const nativeFetch = globalThis.fetch;
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    // Synthetic boundary: storage URLs still pass the application's public URL
    // validation; only the actual native request is routed to the fixture.
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== STORAGE_ORIGIN) {
        throw new Error("Unexpected fetch outside the storage fixture");
      }
      return nativeFetch(
        `http://127.0.0.1:${port}${url.pathname}${url.search}`,
        init,
      );
    };
    await run(responseClosed);
  } finally {
    globalThis.fetch = nativeFetch;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

const closedWithinDeadline = async (closed: Promise<void>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), CLOSE_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const storedImage = (path: string) => {
  mockConvexAction.mockResolvedValue([
    {
      url: `${STORAGE_ORIGIN}${path}?X-Amz-Signature=${SIGNATURE}`,
      sizeBytes: 2 * 1024 * 1024,
      mediaType: "image/png",
      name: "photo.png",
    },
  ]);
  return [
    {
      id: "m1",
      role: "user",
      parts: [
        { type: "text", text: "what is this?" },
        {
          type: "file",
          mediaType: "image/png",
          fileId: "file_photo",
          name: "photo.png",
        },
      ],
    },
  ] as any;
};

describe("processMessageFiles image downloads over real HTTP", () => {
  const consoleSpies: jest.SpyInstance[] = [];

  beforeEach(() => {
    for (const method of ["log", "info", "warn", "error"] as const) {
      consoleSpies.push(
        jest.spyOn(console, method).mockImplementation(() => {}),
      );
    }
  });

  afterEach(() => {
    const logged = JSON.stringify(consoleSpies.map((spy) => spy.mock.calls));
    consoleSpies.splice(0).forEach((spy) => spy.mockRestore());
    expect(logged).not.toContain(SIGNATURE);
  });

  it.each([
    { path: "/oversized.png", mode: "ask" as const },
    { path: "/unavailable.png", mode: "ask" as const },
    { path: "/unavailable.png", mode: "agent" as const },
  ])(
    "closes the open $path response after rejecting it in $mode mode",
    async ({ path, mode }) => {
      await withStorageFixture(async (responseClosed) => {
        const result = await processMessageFiles(
          storedImage(path),
          mode,
          "user123",
          mode === "agent" ? "/home/user/upload" : undefined,
          "pro",
        );

        expect(
          result.messages[0].parts.some((part: any) => part.type === "file"),
        ).toBe(false);
        expect(result.sandboxFiles).toHaveLength(mode === "agent" ? 1 : 0);
        expect(await closedWithinDeadline(responseClosed)).toBe(true);
      });
    },
  );

  it("still validates a completed PNG download", async () => {
    await withStorageFixture(async () => {
      const result = await processMessageFiles(
        storedImage("/valid.png"),
        "ask",
        "user123",
        undefined,
        "pro",
      );

      expect(result.messages[0].parts[1]).toMatchObject({
        type: "file",
        mediaType: "image/png",
        url: `${STORAGE_ORIGIN}/valid.png?X-Amz-Signature=${SIGNATURE}`,
      });
    });
  });
});
