import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { FileUrlCacheProvider } from "@/app/contexts/FileUrlCacheContext";
import { useFileUrlCache } from "@/app/hooks/useFileUrlCache";
import type { ChatMessage } from "@/types";
import type { FilePart } from "@/types/file";
import { FilePartRenderer } from "../FilePartRenderer";

/**
 * Chat history image URLs across the real cache hook, its provider and the
 * renderer. Only the Convex actions are faked; each response is held until the
 * test answers it, so concurrent and duplicate URL signing is counted before
 * anything resolves. Counts describe requests, not network latency.
 */

const SINGLE = "s3Actions:getFileUrlAction";
const BATCH = "s3Actions:getFileUrlsBatchAction";
type Endpoint = typeof SINGLE | typeof BATCH;

type MockRequest = {
  endpoint: Endpoint;
  fileIds: string[];
  settled: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const mockRequests: MockRequest[] = [];
let mockMaxInFlight = 0;
let mockAuth = { isAuthenticated: true, isLoading: false, isRefreshing: false };

function mockSend(endpoint: Endpoint, fileIds: string[]) {
  return new Promise((resolve, reject) => {
    const request: MockRequest = {
      endpoint,
      fileIds,
      settled: false,
      resolve: (value) => {
        request.settled = true;
        resolve(value);
      },
      reject: (error) => {
        request.settled = true;
        reject(error);
      },
    };
    mockRequests.push(request);
    mockMaxInFlight = Math.max(
      mockMaxInFlight,
      mockRequests.filter((r) => !r.settled).length,
    );
  });
}

// Stable identities: both actions are effect dependencies.
const mockEndpoints: Record<string, (args: never) => Promise<unknown>> = {
  [SINGLE]: ({ fileId }: { fileId: string }) => mockSend(SINGLE, [fileId]),
  [BATCH]: ({ fileIds }: { fileIds: string[] }) =>
    mockSend(BATCH, [...fileIds]),
};

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual("convex/server");
  return {
    useAction: (reference: unknown) => {
      const name = getFunctionName(reference);
      const endpoint = mockEndpoints[name];
      if (!endpoint) throw new Error(`Unexpected Convex action: ${name}`);
      return endpoint;
    },
    useConvexAuth: () => ({ ...mockAuth }),
  };
});
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));
jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ alt, src, ...props }: any) => {
    const React = require("react");
    return React.createElement("img", { alt, src, ...props });
  },
}));

const signedUrl = (fileId: string, signature = "current") =>
  `https://files.example/${fileId}?sig=${signature}&X-Amz-Expires=3600`;

/** The server signs every accessible ID it is asked for. */
function respondWithUrls(request: MockRequest, signature = "current") {
  if (request.endpoint === SINGLE) {
    request.resolve(signedUrl(request.fileIds[0], signature));
  } else {
    request.resolve(
      Object.fromEntries(
        request.fileIds.map((id) => [id, signedUrl(id, signature)]),
      ),
    );
  }
}

/** Lets same-tick image requests leave and rendered results commit. */
const flush = () => act(async () => {});

async function mount(ui: ReactElement, options?: { reactStrictMode: boolean }) {
  const view = render(ui, options);
  await flush();
  return view;
}

async function answer(
  respond: (request: MockRequest) => void = (r) => respondWithUrls(r),
  which: (request: MockRequest) => boolean = () => true,
) {
  // Fallback requests may only be sent after earlier answers.
  for (let round = 0; round < 10; round++) {
    const open = mockRequests.filter((r) => !r.settled && which(r));
    if (open.length === 0) return;
    await act(async () => {
      for (const request of open) respond(request);
    });
  }
  throw new Error("URL requests kept arriving after 10 response rounds");
}

function traffic(requests = mockRequests) {
  const signed = new Map<string, number>();
  for (const request of requests)
    for (const id of request.fileIds) signed.set(id, (signed.get(id) ?? 0) + 1);
  return {
    singleRequests: requests.filter((r) => r.endpoint === SINGLE).length,
    batchRequests: requests.filter((r) => r.endpoint === BATCH).length,
    maxSignaturesPerFile: Math.max(0, ...signed.values()),
  };
}

const logRequests = (line: string) =>
  console.info(`Image URL requests, ${line}`);
function record(label: string, heldInFlight: number) {
  const { singleRequests, batchRequests, maxSignaturesPerFile } = traffic();
  const signatures = mockRequests.reduce((n, r) => n + r.fileIds.length, 0);
  logRequests(
    `${label}: single=${singleRequests} batch=${batchRequests} ` +
      `inFlightBeforeAnyResponse=${heldInFlight} maxInFlight=${mockMaxInFlight} ` +
      `signatures=${signatures} maxPerFile=${maxSignaturesPerFile}`,
  );
}

// Uploaded images as saved on user messages: no S3 key on the part.
function uploadedImage(fileId: string) {
  return {
    type: "file",
    mediaType: "image/png",
    fileId,
    name: `${fileId}.png`,
    size: 2048,
    storage: "s3",
  };
}

function userUploads(id: string, fileIds: string[]): ChatMessage {
  return {
    id,
    role: "user",
    parts: [
      ...fileIds.map(uploadedImage),
      { type: "text", text: "What is in these screenshots?" },
    ],
  } as unknown as ChatMessage;
}

// Files saved by Agent tools, loaded with their S3 key in fileDetails.
function savedImages(id: string, fileIds: string[]): ChatMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: "Saved the captures." }],
    fileDetails: fileIds.map((fileId) => ({
      fileId,
      name: `${fileId}.png`,
      mediaType: "image/png",
      s3Key: `users/u1/${fileId}.png`,
      sizeBytes: 2048,
    })),
  } as unknown as ChatMessage;
}

function streamingReply(text: string): ChatMessage {
  return {
    id: "streaming-reply",
    role: "assistant",
    parts: [{ type: "text", text }],
  } as unknown as ChatMessage;
}

const ids = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}_${i}`);

/** File rows as the chat timeline renders them, without the message chrome. */
function MessageFiles({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    const fileParts = message.parts.filter(
      (part) => part.type === "file",
    ) as unknown as FilePart[];
    return (
      <>
        {fileParts.map((part, partIndex) => (
          <FilePartRenderer
            key={`${message.id}-file-${partIndex}`}
            part={part}
            partIndex={partIndex}
            messageId={message.id}
            totalFileParts={fileParts.length}
          />
        ))}
      </>
    );
  }
  return (
    <>
      {(message.fileDetails ?? []).map((file, fileIndex) => (
        <FilePartRenderer
          key={`${message.id}-saved-file-${fileIndex}`}
          part={{
            url: file.url ?? undefined,
            fileId: file.fileId,
            s3Key: file.s3Key,
            name: file.name,
            filename: file.name,
            mediaType: file.mediaType,
          }}
          partIndex={fileIndex}
          messageId={message.id}
        />
      ))}
    </>
  );
}

function ChatHistory({
  messages,
  showRows = true,
}: {
  messages: ChatMessage[];
  showRows?: boolean;
}) {
  const { getCachedUrl, setCachedUrl, loadImageUrl } =
    useFileUrlCache(messages);
  return (
    <FileUrlCacheProvider
      getCachedUrl={getCachedUrl}
      setCachedUrl={setCachedUrl}
      loadImageUrl={loadImageUrl}
    >
      {showRows &&
        messages.map((message) => (
          <MessageFiles key={message.id} message={message} />
        ))}
    </FileUrlCacheProvider>
  );
}

function expectImagesShown(fileIds: string[], signature = "current") {
  for (const fileId of fileIds) {
    for (const image of screen.getAllByAltText(`${fileId}.png`)) {
      expect(image).toHaveAttribute("src", signedUrl(fileId, signature));
    }
  }
  expect(screen.queryByText(/not available|failed/i)).not.toBeInTheDocument();
}

function expectEveryImageShown(fileIds: string[], signature = "current") {
  expectImagesShown(fileIds, signature);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
}

let consoleError: jest.SpyInstance;
beforeEach(() => {
  mockRequests.length = 0;
  mockMaxInFlight = 0;
  mockAuth = { isAuthenticated: true, isLoading: false, isRefreshing: false };
  consoleError = jest.spyOn(console, "error");
});
afterEach(() => consoleError.mockRestore());

describe("chat history image URLs", () => {
  it.each([
    { source: "uploaded", history: (f: string[]) => [userUploads("m1", f)] },
    {
      source: "Agent-saved",
      history: (f: string[]) => f.map((id, i) => savedImages(`m${i}`, [id])),
    },
  ])(
    "signs each of 20 $source images once in one batch on a cold history",
    async ({ source, history }) => {
      const fileIds = ids("file", 20);
      await mount(<ChatHistory messages={history(fileIds)} />);
      const heldInFlight = mockRequests.length;
      expect(screen.getAllByRole("status")).toHaveLength(20);

      await answer();

      expectEveryImageShown(fileIds);
      record(`cold ${source} x20`, heldInFlight);
      expect(traffic()).toEqual({
        singleRequests: 0,
        batchRequests: 1,
        maxSignaturesPerFile: 1,
      });
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  it("signs an image once when several messages show the same file", async () => {
    const shared = ids("shared", 2);
    await mount(
      <ChatHistory
        messages={[
          userUploads("original", shared),
          userUploads("edited", shared),
          savedImages("saved", shared),
        ]}
      />,
    );
    const heldInFlight = mockRequests.length;

    await answer();

    expectEveryImageShown(shared);
    expect(screen.getAllByAltText("shared_0.png")).toHaveLength(3);
    record("same 2 files in 3 messages", heldInFlight);
    expect(traffic()).toEqual({
      singleRequests: 0,
      batchRequests: 1,
      maxSignaturesPerFile: 1,
    });
  });

  it("signs each image once when StrictMode replays effects", async () => {
    const fileIds = ids("upload", 20);
    await mount(<ChatHistory messages={[userUploads("m1", fileIds)]} />, {
      reactStrictMode: true,
    });
    const heldInFlight = mockRequests.length;

    await answer();

    expectEveryImageShown(fileIds);
    record("StrictMode uploaded x20", heldInFlight);
    expect(traffic().maxSignaturesPerFile).toBe(1);
  });

  it("sends no further requests while a reply streams, before or after URLs arrive", async () => {
    const uploads = userUploads("m1", ids("upload", 10));
    const saved = savedImages("m2", ids("saved", 2));
    const { rerender } = await mount(
      <ChatHistory messages={[uploads, saved]} />,
    );
    const afterMount = mockRequests.length;

    for (const text of ["Look", "Looking at", "Looking at the captures"]) {
      rerender(
        <ChatHistory messages={[uploads, saved, streamingReply(text)]} />,
      );
    }
    await flush();
    expect(mockRequests).toHaveLength(afterMount);

    await answer();
    const afterAnswers = mockRequests.length;
    for (const text of ["The first", "The first shows a login form"]) {
      rerender(
        <ChatHistory messages={[uploads, saved, streamingReply(text)]} />,
      );
    }
    await flush();

    expect(mockRequests).toHaveLength(afterAnswers);
    expectEveryImageShown([...ids("upload", 10), ...ids("saved", 2)]);
    record("streaming over 10 uploaded + 2 saved", afterMount);
  });

  it("shows cached images without requests when rows remount", async () => {
    const fileIds = ids("upload", 20);
    const messages = [userUploads("m1", fileIds)];
    const { rerender } = await mount(<ChatHistory messages={messages} />);
    await answer();
    const beforeRemount = mockRequests.length;

    rerender(<ChatHistory messages={messages} showRows={false} />);
    rerender(<ChatHistory messages={messages} showRows />);

    // Rendered from the cache on the first frame, not after a request.
    expectEveryImageShown(fileIds);
    await flush();
    logRequests(
      `warm remount uploaded x20: requests=${mockRequests.length - beforeRemount}`,
    );
    expect(mockRequests).toHaveLength(beforeRemount);
  });

  it("shows a new message's images without waiting for older history requests", async () => {
    const older = ids("older", 60).map((id, i) => savedImages(`old${i}`, [id]));
    const { rerender } = await mount(<ChatHistory messages={older} />);
    expect(mockRequests.map((r) => r.fileIds.length)).toEqual([50, 10]);
    const newIds = ids("new", 20);

    rerender(<ChatHistory messages={[...older, userUploads("new", newIds)]} />);
    await flush();
    const coversNew = (r: MockRequest) =>
      r.fileIds.some((id) => newIds.includes(id));
    expect(mockRequests.filter(coversNew)).toEqual([
      expect.objectContaining({ endpoint: BATCH, fileIds: newIds }),
    ]);
    await answer(undefined, coversNew);

    // Older history requests are all still unanswered.
    expectImagesShown(newIds);
    expect(screen.getAllByRole("status")).toHaveLength(60);
    logRequests(
      `20 new uploads behind 60 saved: heldOlderRequests=${
        mockRequests.filter((r) => !coversNew(r)).length
      } newRequests=${mockRequests.filter(coversNew).length}`,
    );

    await answer();
    expectEveryImageShown([...ids("older", 60), ...newIds]);
  });

  describe("when a batch cannot sign an image", () => {
    beforeEach(() => consoleError.mockImplementation(() => {}));

    it.each([
      {
        batch: "fails",
        respond: (r: MockRequest) => r.reject(new Error("Connection lost")),
      },
      { batch: "omits the files", respond: (r: MockRequest) => r.resolve({}) },
    ])(
      "asks for each file once on its own when the batch $batch",
      async ({ respond }) => {
        const fileIds = ids("saved", 3);
        await mount(<ChatHistory messages={[savedImages("m1", fileIds)]} />);

        await answer((r) =>
          r.endpoint === BATCH ? respond(r) : respondWithUrls(r),
        );

        expectEveryImageShown(fileIds);
        expect(traffic()).toEqual({
          singleRequests: 3,
          batchRequests: 1,
          maxSignaturesPerFile: 2,
        });
        expect(toast.error).not.toHaveBeenCalled();
      },
    );

    it("reports a file the server cannot sign instead of loading forever", async () => {
      const { rerender } = await mount(
        <ChatHistory messages={[userUploads("m1", ["deleted"])]} />,
      );

      await answer((r) => r.resolve(r.endpoint === BATCH ? {} : null));

      expect(screen.getByText("File not available")).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      rerender(
        <ChatHistory
          messages={[userUploads("m1", ["deleted"]), streamingReply("Hm")]}
        />,
      );
      await flush();
      expect(traffic()).toEqual({
        singleRequests: 1,
        batchRequests: 1,
        maxSignaturesPerFile: 2,
      });
    });

    it("asks again when a failed image is shown again, but not while a reply streams", async () => {
      const messages = [userUploads("m1", ["flaky"])];
      const { rerender } = await mount(<ChatHistory messages={messages} />);
      await answer((r) =>
        r.endpoint === BATCH
          ? r.resolve({})
          : r.reject(new Error("Connection lost")),
      );
      expect(screen.getByText("Connection lost")).toBeInTheDocument();

      for (const text of ["Checking", "Checking the upload"]) {
        rerender(
          <ChatHistory messages={[...messages, streamingReply(text)]} />,
        );
      }
      await flush();
      expect(traffic()).toEqual({
        singleRequests: 1,
        batchRequests: 1,
        maxSignaturesPerFile: 2,
      });

      rerender(<ChatHistory messages={messages} showRows={false} />);
      rerender(<ChatHistory messages={messages} showRows />);
      await flush();
      expect(traffic().batchRequests).toBe(2);
      await answer();

      expectEveryImageShown(["flaky"]);
      expect(traffic().singleRequests).toBe(1);
    });
  });

  it("replaces loaded images with URLs signed for the refreshed session", async () => {
    const fileIds = ids("upload", 2);
    const messages = [userUploads("m1", fileIds)];
    const { rerender } = await mount(<ChatHistory messages={messages} />);
    await answer((r) => respondWithUrls(r, "previous"));
    expectEveryImageShown(fileIds, "previous");

    mockAuth = { ...mockAuth, isRefreshing: true };
    rerender(<ChatHistory messages={messages} />);
    await flush();
    expect(screen.getAllByRole("status")).toHaveLength(2);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(mockRequests).toHaveLength(1);

    mockAuth = { ...mockAuth, isRefreshing: false };
    rerender(<ChatHistory messages={messages} />);
    await flush();
    expect(traffic().batchRequests).toBe(2);
    await answer((r) => respondWithUrls(r, "renewed"));

    expectEveryImageShown(fileIds, "renewed");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("loads images again with the refreshed session and ignores answers signed before it", async () => {
    const fileIds = ids("upload", 2);
    const messages = [userUploads("m1", fileIds)];
    const { rerender } = await mount(<ChatHistory messages={messages} />);
    expect(mockRequests).toHaveLength(1);

    mockAuth = { ...mockAuth, isRefreshing: true };
    rerender(<ChatHistory messages={messages} />);
    await answer((r) => respondWithUrls(r, "previous"));
    expect(screen.getAllByRole("status")).toHaveLength(2);

    mockAuth = { ...mockAuth, isRefreshing: false };
    rerender(<ChatHistory messages={messages} />);
    await flush();
    expect(traffic().batchRequests).toBe(2);
    await answer();

    expectEveryImageShown(fileIds);
    rerender(<ChatHistory messages={messages} showRows={false} />);
    rerender(<ChatHistory messages={messages} showRows />);
    expectEveryImageShown(fileIds);
    await flush();
    expect(mockRequests).toHaveLength(2);
    expect(toast.error).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("never shows a stored image's own URL in place of one resolved for it", async () => {
    const stale = "https://files.example/stale-preview.png";
    const direct = "https://files.example/direct.png";
    const messages = [
      {
        id: "m1",
        role: "user",
        parts: [
          { ...uploadedImage("kept"), url: stale },
          { ...uploadedImage("gone"), url: stale },
          {
            type: "file",
            mediaType: "image/png",
            name: "direct.png",
            url: direct,
          },
        ],
      } as unknown as ChatMessage,
    ];
    const staleImages = () =>
      screen
        .queryAllByRole("img")
        .filter((img) => img.getAttribute("src") === stale);
    const respond = (signature: string) => (r: MockRequest) =>
      r.endpoint === BATCH
        ? r.resolve({ kept: signedUrl("kept", signature) })
        : r.resolve(null);

    const { rerender } = await mount(<ChatHistory messages={messages} />);
    expect(staleImages()).toHaveLength(0);
    expect(screen.getAllByRole("status")).toHaveLength(2);
    expect(screen.getByAltText("direct.png")).toHaveAttribute("src", direct);

    await answer(respond("current"));
    expect(screen.getByAltText("kept.png")).toHaveAttribute(
      "src",
      signedUrl("kept"),
    );
    expect(screen.getByText("File not available")).toBeInTheDocument();
    expect(staleImages()).toHaveLength(0);

    mockAuth = { ...mockAuth, isRefreshing: true };
    rerender(<ChatHistory messages={messages} />);
    await flush();
    expect(staleImages()).toHaveLength(0);
    expect(screen.queryByAltText("kept.png")).not.toBeInTheDocument();
    expect(screen.getByAltText("direct.png")).toHaveAttribute("src", direct);

    mockAuth = { ...mockAuth, isRefreshing: false };
    rerender(<ChatHistory messages={messages} />);
    await flush();
    await answer(respond("renewed"));
    expect(screen.getByAltText("kept.png")).toHaveAttribute(
      "src",
      signedUrl("kept", "renewed"),
    );
    expect(staleImages()).toHaveLength(0);
    // The image without a stored file is shown from its URL, never requested.
    expect(new Set(mockRequests.flatMap((r) => r.fileIds))).toEqual(
      new Set(["kept", "gone"]),
    );
  });

  it("quietly ignores answers that arrive after the chat closes", async () => {
    const { unmount } = await mount(
      <ChatHistory messages={[savedImages("m1", ids("saved", 3))]} />,
    );

    unmount();
    await answer((r) => r.reject(new Error("Connection closed")));

    expect(traffic().singleRequests).toBe(0);
    expect(toast.error).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
