import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { Chat } from "@ai-sdk/react";
import type { ChatMessage, QueuedMessage } from "@/types/chat";
import { useQueuedMessageDelivery } from "../useQueuedMessageDelivery";
import { toast } from "sonner";

jest.mock("@/lib/chat/agent-long-transport", () => ({
  getPendingAgentLongRunStart: jest.fn(),
}));
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));

const message: QueuedMessage = {
  id: "queued-1",
  text: "Inspect the attached file",
  timestamp: 123,
  files: [
    {
      type: "file",
      mediaType: "text/plain",
      name: "example.txt",
      size: 8,
      fileId: "file-1",
    },
  ],
};
const sendMessage = jest.fn(async () => {});
const resumeStream = jest.fn(async () => {});
const fetchMock = jest.fn();

function setup(
  options: {
    message?: QueuedMessage;
    messages?: ChatMessage[];
    send?: typeof sendMessage;
    isStopped?: () => boolean;
    getRequestGeneration?: () => number;
  } = {},
) {
  return renderHook(
    ({ chatId, blocked }: { chatId: string; blocked?: string }) => {
      const [queue, setQueue] = useState([options.message ?? message]);
      const delivery = useQueuedMessageDelivery({
        chatId,
        messages: options.messages ?? [],
        queue,
        enabled: true,
        isStopped: options.isStopped,
        getRequestGeneration: options.getRequestGeneration,
        sendDisabledReason: blocked,
        sendMessage: options.send ?? sendMessage,
        resumeStream,
        remove: (id) =>
          setQueue((items) => items.filter((item) => item.id !== id)),
        setDelivery: (id, deliveryStatus, firstAttemptAt) =>
          setQueue((items) =>
            items.map((item) =>
              item.id === id
                ? { ...item, deliveryStatus, firstAttemptAt }
                : item,
            ),
          ),
      });
      return { ...delivery, queue, remove: () => setQueue([]) };
    },
    {
      initialProps: { chatId: "chat-1", blocked: undefined } as {
        chatId: string;
        blocked?: string;
      },
    },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  sendMessage.mockReset().mockResolvedValue(undefined);
  resumeStream.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset().mockResolvedValue({ status: 204 });
  global.fetch = fetchMock;
});

it("retains text and attachments after a rejected send and holds automatic delivery", async () => {
  sendMessage.mockRejectedValueOnce(new Error("offline"));
  const { result } = setup();
  await act(() => result.current.send(message.id, { selectedModel: "latest" }));
  expect(result.current.queue).toEqual([
    expect.objectContaining({ ...message, deliveryStatus: "failed" }),
  ]);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      id: message.id,
      parts: [message.files![0], { type: "text", text: message.text }],
    }),
    { body: { selectedModel: "latest" } },
  );
});

it("does not confuse a real SDK onError/resolved promise with admission", async () => {
  const onError = jest.fn();
  const sdk = new Chat<ChatMessage>({
    id: "chat-1",
    onError,
    transport: {
      sendMessages: async () => {
        throw new Error("synthetic transport failure");
      },
      reconnectToStream: async () => null,
    },
  });
  const send = jest.fn(sdk.sendMessage);
  const { result } = setup({ send });
  await act(() => result.current.send(message.id, {}));
  expect(onError).toHaveBeenCalledTimes(1);
  expect(sdk.status).toBe("error");
  expect(sdk.messages[0].id).toBe(message.id);
  expect(result.current.queue[0].deliveryStatus).toBe("failed");
});

it("retires only an acknowledged matching send, even if its stream later fails", async () => {
  let reject!: (error: Error) => void;
  sendMessage.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const { result } = setup();
  let sending!: Promise<void>;
  act(() => {
    sending = result.current.send(message.id, {});
  });
  act(() => result.current.accept("other-chat", message.id));
  expect(result.current.queue).toHaveLength(1);
  act(() => result.current.accept("chat-1", "other-message"));
  expect(result.current.queue).toHaveLength(1);
  act(() => result.current.accept("chat-1", message.id));
  expect(result.current.queue).toHaveLength(0);
  await act(async () => {
    await sending;
  });
  await act(async () => {
    reject(new Error("stream disconnected"));
    await sending;
  });
  expect(result.current.queue).toHaveLength(0);
  expect(toast.error).not.toHaveBeenCalled();
});

it("reconnects an active run without resending or discarding the queued intent", async () => {
  fetchMock.mockResolvedValueOnce({ status: 200 });
  const { result } = setup({
    message: {
      ...message,
      deliveryStatus: "failed",
      firstAttemptAt: Date.now(),
    },
  });
  await act(() => result.current.send(message.id, {}));
  expect(fetchMock).toHaveBeenCalledWith("/api/agent/resume?chatId=chat-1", {
    cache: "no-store",
  });
  expect(resumeStream).toHaveBeenCalledTimes(1);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(result.current.queue[0].deliveryStatus).toBe("failed");
});

it("retries only after a 204 and retains the user-message ID instead of appending a duplicate", async () => {
  const { result } = setup({
    message: {
      ...message,
      deliveryStatus: "failed",
      firstAttemptAt: Date.now(),
    },
    messages: [{ id: message.id, role: "user", parts: [] }],
  });
  await act(() =>
    result.current.send(message.id, { selectedModel: "current" }),
  );
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ id: message.id, messageId: message.id }),
    { body: { selectedModel: "current" } },
  );
});

it.each([403, 500])(
  "holds the item when admission reconciliation returns %s",
  async (status) => {
    fetchMock.mockResolvedValueOnce({ status });
    const { result } = setup({
      message: {
        ...message,
        deliveryStatus: "failed",
        firstAttemptAt: Date.now(),
      },
    });
    await act(() => result.current.send(message.id, {}));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.current.queue[0].deliveryStatus).toBe("failed");
  },
);

it("does not retry outside the bounded deduplication window", async () => {
  const { result } = setup({
    message: {
      ...message,
      deliveryStatus: "failed",
      firstAttemptAt: Date.now() - 300_000,
    },
  });
  await act(() => result.current.send(message.id, {}));
  expect(sendMessage).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining("Reload this chat"),
  );
});

it("does not truncate a newer user turn to retry an older queued request", async () => {
  const { result } = setup({
    message: {
      ...message,
      deliveryStatus: "failed",
      firstAttemptAt: Date.now(),
    },
    messages: [
      { id: message.id, role: "user", parts: [] },
      { id: "newer", role: "user", parts: [] },
    ],
  });
  await act(() => result.current.send(message.id, {}));
  expect(sendMessage).not.toHaveBeenCalled();
});

it("ignores a late completion after navigation", async () => {
  let finish!: () => void;
  sendMessage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, rerender } = setup();
  let sending!: Promise<void>;
  act(() => {
    sending = result.current.send(message.id, {});
  });
  rerender({ chatId: "chat-2" });
  act(() => result.current.accept("chat-1", message.id));
  await act(async () => {
    finish();
    await sending;
  });
  expect(result.current.queue[0].deliveryStatus).toBe("sending");
  expect(toast.error).not.toHaveBeenCalled();
});

it("does not resurrect a deleted item or dispatch after deletion during reconciliation", async () => {
  let finish!: (response: { status: number }) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = setup({
    message: {
      ...message,
      deliveryStatus: "failed",
      firstAttemptAt: Date.now(),
    },
  });
  let sending!: Promise<void>;
  act(() => {
    sending = result.current.send(message.id, {});
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  act(() => result.current.remove());
  await act(async () => {
    finish({ status: 204 });
    await sending;
  });
  expect(sendMessage).not.toHaveBeenCalled();
  expect(result.current.queue).toHaveLength(0);
});

it("blocks duplicate clicks and honors a disconnected selected computer", async () => {
  const { result, rerender } = setup();
  rerender({ chatId: "chat-1", blocked: "Reconnect computer" });
  await act(() => result.current.send(message.id, {}));
  expect(sendMessage).not.toHaveBeenCalled();
  rerender({ chatId: "chat-1" });
  await act(async () => {
    await Promise.all([
      result.current.send(message.id, {}),
      result.current.send(message.id, {}),
    ]);
  });
  expect(sendMessage).toHaveBeenCalledTimes(1);
});

it.each(["stop", "new request"])(
  "does not dispatch when %s interrupts reconciliation",
  async (interruption) => {
    let stopped = false;
    let generation = 0;
    let finish!: (response: { status: number }) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = setup({
      message: {
        ...message,
        deliveryStatus: "failed",
        firstAttemptAt: Date.now(),
      },
      isStopped: () => stopped,
      getRequestGeneration: () => generation,
    });
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send(message.id, {});
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    if (interruption === "stop") stopped = true;
    else generation++;
    await act(async () => {
      finish({ status: 204 });
      await sending;
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.current.queue[0].deliveryStatus).toBe("failed");
  },
);
