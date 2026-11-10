import { generateId } from "ai";
import { startStream } from "@/lib/db/actions";
import { phLogger } from "@/lib/posthog/server";
import { setupChatStreamResumption } from "../chat-stream-resumption";

jest.mock("ai", () => ({ generateId: jest.fn() }));
jest.mock("@/lib/db/actions", () => ({ startStream: jest.fn() }));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { warn: jest.fn() } }));

const ownedStream = () =>
  new ReadableStream<string>({
    start(controller) {
      controller.enqueue("owned fixture");
      controller.close();
    },
  });

beforeEach(() => {
  jest.mocked(generateId).mockReset().mockReturnValue("opaque-stream");
  jest.mocked(startStream).mockReset().mockResolvedValue(undefined);
  jest.mocked(phLogger.warn).mockClear();
});

it.each(["register", "create_stream"] as const)(
  "retains the generated ID and %s failure without retrying or failing the response",
  async (stage) => {
    const stream = ownedStream();
    const failure = new Error("original setup failure");
    const create = jest.fn(
      async (_id: string, make: () => ReadableStream<string>) => make(),
    );
    if (stage === "register")
      jest.mocked(startStream).mockRejectedValueOnce(failure);
    else create.mockRejectedValueOnce(failure);
    await expect(
      setupChatStreamResumption({
        chatId: "opaque-chat",
        stream,
        getStreamContext: () => ({ createNewResumableStream: create }),
      }),
    ).resolves.toBeUndefined();
    expect(startStream).toHaveBeenCalledTimes(1);
    expect(startStream).toHaveBeenCalledWith({
      chatId: "opaque-chat",
      streamId: "opaque-stream",
    });
    if (stage === "register") expect(create).not.toHaveBeenCalled();
    else {
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0]).toBe("opaque-stream");
      expect(create.mock.calls[0][1]()).toBe(stream);
    }
    expect(phLogger.warn).toHaveBeenCalledWith(
      "Stream resumption setup failed",
      {
        chatId: "opaque-chat",
        error: failure.message,
        stream_resumption_diagnostic_version: 1,
        stream_resumption_phase: stage,
        stream_id: "opaque-stream",
      },
    );
  },
);

it.each(["context", "generate_id"] as const)(
  "reports %s failure without inventing a registered stream ID",
  async (stage) => {
    const failure = new Error("original setup failure");
    const create = jest.fn();
    if (stage === "generate_id")
      jest.mocked(generateId).mockImplementationOnce(() => {
        throw failure;
      });
    await expect(
      setupChatStreamResumption({
        chatId: "opaque-chat",
        stream: ownedStream(),
        getStreamContext: () => {
          if (stage === "context") throw failure;
          return { createNewResumableStream: create };
        },
      }),
    ).resolves.toBeUndefined();
    expect(startStream).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(phLogger.warn).toHaveBeenCalledWith(
      "Stream resumption setup failed",
      expect.objectContaining({
        stream_resumption_diagnostic_version: 1,
        stream_resumption_phase: stage,
        stream_id: null,
      }),
    );
  },
);

it("keeps unavailable optional contexts silent and leaves the response stream readable", async () => {
  const stream = ownedStream();
  await setupChatStreamResumption({
    chatId: "opaque-chat",
    stream,
    getStreamContext: () => null,
  });
  expect(generateId).not.toHaveBeenCalled();
  expect(startStream).not.toHaveBeenCalled();
  expect(phLogger.warn).not.toHaveBeenCalled();
  expect(await stream.getReader().read()).toMatchObject({
    value: "owned fixture",
    done: false,
  });
});

it("registers the same generated ID before creating the resumable store once", async () => {
  const order: string[] = [];
  const stream = ownedStream();
  jest.mocked(startStream).mockImplementationOnce(async () => {
    order.push("register");
  });
  const create = jest.fn(
    async (id: string, make: () => ReadableStream<string>) => {
      order.push("create");
      expect(id).toBe("opaque-stream");
      expect(make()).toBe(stream);
      return stream;
    },
  );
  await setupChatStreamResumption({
    chatId: "opaque-chat",
    stream,
    getStreamContext: () => ({ createNewResumableStream: create }),
  });
  expect(order).toEqual(["register", "create"]);
  expect(startStream).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledTimes(1);
  expect(phLogger.warn).not.toHaveBeenCalled();
});

it("keeps concurrent request IDs and failure phases separate when registrations reject out of order", async () => {
  jest
    .mocked(generateId)
    .mockReturnValueOnce("opaque-first")
    .mockReturnValueOnce("opaque-second");
  const reject = new Map<string, (error: Error) => void>();
  jest.mocked(startStream).mockImplementation(
    ({ streamId }) =>
      new Promise<void>((_resolve, fail) => {
        reject.set(streamId, fail);
      }),
  );
  const create = jest.fn();
  const runs = ["first", "second"].map((chatId) =>
    setupChatStreamResumption({
      chatId,
      stream: ownedStream(),
      getStreamContext: () => ({ createNewResumableStream: create }),
    }),
  );
  reject.get("opaque-second")!(new Error("owned second failure"));
  reject.get("opaque-first")!(new Error("owned first failure"));
  await Promise.all(runs);
  expect(startStream).toHaveBeenCalledTimes(2);
  expect(create).not.toHaveBeenCalled();
  for (const name of ["first", "second"])
    expect(phLogger.warn).toHaveBeenCalledWith(
      "Stream resumption setup failed",
      expect.objectContaining({
        chatId: name,
        stream_id: `opaque-${name}`,
        stream_resumption_phase: "register",
      }),
    );
});
