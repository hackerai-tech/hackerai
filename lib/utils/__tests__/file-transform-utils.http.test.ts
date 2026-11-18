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
const PDF_BYTES = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n%%EOF\n", "latin1");
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
  "/unavailable.pdf": (res) => {
    res.writeHead(503, { "content-type": "text/plain" });
    res.write("temporarily unavailable");
  },
  "/report.pdf": (res) => {
    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": String(PDF_BYTES.byteLength),
    });
    res.end(PDF_BYTES);
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
  run: (
    responseClosed: Promise<void>,
    requestedPaths: string[],
  ) => Promise<void>,
) => {
  let markClosed!: () => void;
  const responseClosed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const requestedPaths: string[] = [];
  const server = createServer((req, res) => {
    res.on("close", markClosed);
    const { pathname } = new URL(req.url ?? "/", "http://fixture");
    requestedPaths.push(pathname);
    const route = routes[pathname];
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
    await run(responseClosed, requestedPaths);
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

const signedUrl = (path: string) =>
  `${STORAGE_ORIGIN}${path}?X-Amz-Signature=${SIGNATURE}`;

const storedFile = (path: string, mediaType = "image/png") => {
  const name = mediaType === "image/png" ? "photo.png" : "report.pdf";
  mockConvexAction.mockResolvedValue([
    { url: signedUrl(path), sizeBytes: 2 * 1024 * 1024, mediaType, name },
  ]);
  return [
    {
      id: "m1",
      role: "user",
      parts: [
        { type: "text", text: "what is this?" },
        { type: "file", mediaType, fileId: "file_stored", name },
      ],
    },
  ] as any;
};

describe("processMessageFiles attachment downloads over real HTTP", () => {
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
          storedFile(path),
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
        storedFile("/valid.png"),
        "ask",
        "user123",
        undefined,
        "pro",
      );

      expect(result.messages[0].parts[1]).toMatchObject({
        type: "file",
        mediaType: "image/png",
        url: signedUrl("/valid.png"),
      });
    });
  });

  it("keeps the signed URL and closes an unavailable Ask PDF response", async () => {
    await withStorageFixture(async (responseClosed) => {
      const result = await processMessageFiles(
        storedFile("/unavailable.pdf", "application/pdf"),
        "ask",
        "user123",
        undefined,
        "pro",
      );

      expect(result.messages[0].parts[1]).toMatchObject({
        type: "file",
        mediaType: "application/pdf",
        url: signedUrl("/unavailable.pdf"),
      });
      expect(await closedWithinDeadline(responseClosed)).toBe(true);
    });
  });

  it("inlines a completed Ask PDF download as exact base64 bytes", async () => {
    await withStorageFixture(async () => {
      const result = await processMessageFiles(
        storedFile("/report.pdf", "application/pdf"),
        "ask",
        "user123",
        undefined,
        "pro",
      );

      expect(result.messages[0].parts[1]).toMatchObject({
        type: "file",
        mediaType: "application/pdf",
        url: `data:application/pdf;base64,${PDF_BYTES.toString("base64")}`,
      });
    });
  });

  it("passes Agent PDFs through by signed URL without downloading them", async () => {
    await withStorageFixture(async (_responseClosed, requestedPaths) => {
      const result = await processMessageFiles(
        storedFile("/report.pdf", "application/pdf"),
        "agent",
        "user123",
        "/home/user/upload",
        "pro",
      );

      expect(requestedPaths).toEqual([]);
      expect(result.messages[0].parts[1]).toMatchObject({
        type: "file",
        mediaType: "application/pdf",
        url: signedUrl("/report.pdf"),
      });
      expect(result.sandboxFiles).toEqual([
        expect.objectContaining({ kind: "url", url: signedUrl("/report.pdf") }),
      ]);
    });
  });
});
