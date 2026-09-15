import {
  cancelAgentLongRealtimeStreams,
  fetchAgentLongStream,
  getPendingAgentLongRunStart,
} from "../agent-long-transport";

const pendingResponse = () => {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const handleResponse = (runId: string) =>
  ({
    ok: true,
    json: async () => ({ runId, publicAccessToken: "synthetic" }),
  }) as Response;
const init = (signal?: AbortSignal) => ({
  method: "POST",
  body: JSON.stringify({ chatId: "handoff-chat" }),
  signal,
});

beforeEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: jest.fn(),
  });
});

it("does not start a request that was already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    fetchAgentLongStream(init(controller.signal)),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
  expect(getPendingAgentLongRunStart("handoff-chat")).toBeUndefined();
});

it("navigation detaches a pending start without canceling durable work or attaching stale UI", async () => {
  const pending = pendingResponse();
  jest.mocked(fetch).mockReturnValueOnce(pending.promise);
  const onRunStarted = jest.fn();
  const response = fetchAgentLongStream(init(), onRunStarted).catch(
    (error) => error,
  );
  const handoff = getPendingAgentLongRunStart("handoff-chat");
  cancelAgentLongRealtimeStreams("handoff-chat");
  pending.resolve(handleResponse("run-navigation"));
  expect(await handoff).toMatchObject({ runId: "run-navigation" });
  expect(await response).toMatchObject({ name: "AbortError" });
  expect(onRunStarted).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(getPendingAgentLongRunStart("handoff-chat")).toBeUndefined();
});

it("an older start finishing does not remove a newer pending start", async () => {
  const first = pendingResponse();
  const second = pendingResponse();
  jest
    .mocked(fetch)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const oldResponse = fetchAgentLongStream(init()).catch((error) => error);
  const oldHandoff = getPendingAgentLongRunStart("handoff-chat");
  const newResponse = fetchAgentLongStream(init()).catch((error) => error);
  cancelAgentLongRealtimeStreams("handoff-chat");
  first.resolve(handleResponse("run-old"));
  expect(await oldHandoff).toMatchObject({ runId: "run-old" });
  await oldResponse;
  const newHandoff = getPendingAgentLongRunStart("handoff-chat");
  expect(newHandoff).toBeDefined();
  second.resolve(handleResponse("run-new"));
  expect(await newHandoff).toMatchObject({ runId: "run-new" });
  await newResponse;
  expect(getPendingAgentLongRunStart("handoff-chat")).toBeUndefined();
});

it("surfaces a failed start to Stop and releases the pending handle", async () => {
  const pending = pendingResponse();
  jest.mocked(fetch).mockReturnValueOnce(pending.promise);
  const response = fetchAgentLongStream(init()).catch((error) => error);
  const handoff = getPendingAgentLongRunStart("handoff-chat")!.catch(
    (error) => error,
  );
  pending.reject(new Error("Synthetic network failure"));
  expect(await response).toMatchObject({
    message: "Synthetic network failure",
  });
  expect(await handoff).toMatchObject({ message: "Synthetic network failure" });
  expect(getPendingAgentLongRunStart("handoff-chat")).toBeUndefined();
});
