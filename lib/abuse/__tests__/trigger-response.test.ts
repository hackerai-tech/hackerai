/** @jest-environment node */
import {
  createTriggerResponseAdapters,
  startTriggerOperation,
  TRIGGER_ATTEMPT_TIMEOUT_MS,
  TriggerRequestError,
  type TriggerOperation,
} from "../trigger-response";

// Synthetic connection; no network. Fetch is faked at the HTTP boundary.
const BASE = "https://trigger.example.test";
const SECRET = "tr_preview_syntheticvalue";

function adapters(fetch: jest.Mock) {
  return createTriggerResponseAdapters({
    baseUrl: `${BASE}/`,
    secretKey: SECRET,
    branch: "synthetic-branch",
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
}
const json = (body: unknown, status = 200, type = "application/json") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": type },
  });
/** Settles only when the request's own signal aborts. */
const hung = (_url: string, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) =>
    init.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
  );

/**
 * Headers arrive, then the body stalls after a partial chunk. The stream is not
 * tied to the request signal, so only the adapter's own reader cancellation
 * can end it.
 */
function stalled(type = "application/json") {
  const cancelled = jest.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":'));
      },
      cancel: cancelled,
    }),
    { status: 200, headers: { "content-type": type } },
  );
  return { response, cancelled };
}
const runWithPacket = () =>
  json({
    status: "EXECUTING",
    taskIdentifier: "agent-long",
    payloadPresignedUrl: "https://storage.example.test/packet",
  });

let operation: ReturnType<typeof startTriggerOperation>;
beforeEach(() => {
  operation = startTriggerOperation();
});
afterEach(() => {
  operation.dispose();
  jest.useRealTimers();
});

test.each([400, 404, 409, 410, 422])(
  "a %s is an unconfirmed outcome for cancellation and approval closure, never success",
  async (status) => {
    const fetch = jest.fn(async () =>
      json({ error: "private detail" }, status),
    );
    const trigger = adapters(fetch);
    const cancel = await trigger
      .cancelRun("run_x", operation)
      .catch((error) => error);
    expect(cancel).toBeInstanceOf(TriggerRequestError);
    expect(cancel.status).toBe(status);
    expect(cancel.message).not.toContain("private detail");
    await expect(
      trigger.closeApprovalSession("session_x", "reason", operation),
    ).rejects.toMatchObject({ status });
    // Non-transient rejections are not retried.
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

test("only transient failures are retried, within the attempt bound", async () => {
  const failing = jest.fn(async () => json({}, 503));
  await expect(
    adapters(failing).cancelRun("run_x", operation),
  ).rejects.toMatchObject({ status: 503 });
  expect(failing).toHaveBeenCalledTimes(2);

  const recovering = jest
    .fn()
    .mockRejectedValueOnce(new Error("synthetic socket reset"))
    .mockResolvedValueOnce(json({ id: "run_x" }));
  await expect(
    adapters(recovering).cancelRun("run_x", operation),
  ).resolves.toBeUndefined();
  expect(recovering).toHaveBeenCalledTimes(2);
});

test("requests carry authentication, branch and an abort signal; presigned payloads get no credentials", async () => {
  const fetch = jest
    .fn()
    .mockResolvedValueOnce(
      json({
        status: "EXECUTING",
        taskIdentifier: "agent-long",
        payloadPresignedUrl: "https://storage.example.test/packet",
      }),
    )
    .mockResolvedValueOnce(
      json(
        { json: { userId: "subject", chatId: "chat" } },
        200,
        "application/super+json",
      ),
    )
    .mockResolvedValueOnce(json({ id: "session_x" }));
  const trigger = adapters(fetch);
  await expect(trigger.retrieveRun("run_x", operation)).resolves.toEqual({
    status: "EXECUTING",
    taskIdentifier: "agent-long",
    payload: { userId: "subject", chatId: "chat" },
  });
  await trigger.closeApprovalSession(
    "session_x",
    "reviewed_security_abuse",
    operation,
  );
  const [runCall, packetCall, closeCall] = fetch.mock.calls;
  expect(runCall[0]).toBe(`${BASE}/api/v3/runs/run_x`);
  expect(runCall[1]).toMatchObject({
    method: "GET",
    headers: {
      Authorization: `Bearer ${SECRET}`,
      "x-trigger-branch": "synthetic-branch",
    },
  });
  expect(runCall[1].signal).toBeInstanceOf(AbortSignal);
  expect(packetCall[0]).toBe("https://storage.example.test/packet");
  expect(packetCall[1].headers).toBeUndefined();
  expect(packetCall[1].signal).toBeInstanceOf(AbortSignal);
  expect(closeCall[0]).toBe(`${BASE}/api/v1/sessions/session_x/close`);
  expect(closeCall[1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({ reason: "reviewed_security_abuse" }),
  });
});

test("aborting the operation aborts the in-flight request and dispatches nothing more", async () => {
  const controller = new AbortController();
  const live: TriggerOperation = {
    signal: controller.signal,
    deadline: Date.now() + 60_000,
  };
  const fetch = jest.fn(hung);
  const pending = adapters(fetch).cancelRun("run_x", live);
  await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(TriggerRequestError);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
});

test("a passed deadline prevents dispatch even before the abort timer fires", async () => {
  const fetch = jest.fn(async () => json({}));
  const expired: TriggerOperation = {
    signal: new AbortController().signal,
    deadline: Date.now() - 1,
  };
  await expect(
    adapters(fetch).cancelRun("run_x", expired),
  ).rejects.toBeInstanceOf(TriggerRequestError);
  expect(fetch).not.toHaveBeenCalled();
});

test("each hung attempt is aborted at its timeout and attempts stay bounded", async () => {
  jest.useFakeTimers();
  const bounded: TriggerOperation = {
    signal: new AbortController().signal,
    deadline: Date.now() + 10 * TRIGGER_ATTEMPT_TIMEOUT_MS,
  };
  const fetch = jest.fn(hung);
  const pending = adapters(fetch)
    .retrieveRun("run_x", bounded)
    .catch((error) => error);
  await jest.advanceTimersByTimeAsync(TRIGGER_ATTEMPT_TIMEOUT_MS);
  await jest.advanceTimersByTimeAsync(TRIGGER_ATTEMPT_TIMEOUT_MS);
  expect(await pending).toBeInstanceOf(TriggerRequestError);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true);
});

test("aborting the operation while a response body stalls cancels the read and settles", async () => {
  const body = stalled();
  const fetch = jest.fn(async () => body.response);
  const controller = new AbortController();
  const live: TriggerOperation = {
    signal: controller.signal,
    deadline: Date.now() + 60_000,
  };
  const pending = adapters(fetch)
    .retrieveRun("run_x", live)
    .catch((error) => error);
  // Let the headers resolve and the body read begin before aborting.
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  expect(await pending).toBeInstanceOf(TriggerRequestError);
  expect(body.cancelled).toHaveBeenCalled();
  // The aborted operation also blocks a retry.
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("a stalled API body times out per attempt and attempts stay bounded", async () => {
  jest.useFakeTimers();
  const bodies = [stalled(), stalled()];
  const fetch = jest.fn(
    async () => bodies[fetch.mock.calls.length - 1].response,
  );
  const bounded: TriggerOperation = {
    signal: new AbortController().signal,
    deadline: Date.now() + 10 * TRIGGER_ATTEMPT_TIMEOUT_MS,
  };
  const pending = adapters(fetch)
    .cancelRun("run_x", bounded)
    .catch((error) => error);
  await jest.advanceTimersByTimeAsync(TRIGGER_ATTEMPT_TIMEOUT_MS);
  await jest.advanceTimersByTimeAsync(TRIGGER_ATTEMPT_TIMEOUT_MS);
  expect(await pending).toBeInstanceOf(TriggerRequestError);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const body of bodies) expect(body.cancelled).toHaveBeenCalled();
});

test("a stalled presigned payload body times out instead of hanging the lookup", async () => {
  jest.useFakeTimers();
  const packet = stalled("application/super+json");
  const fetch = jest
    .fn()
    .mockResolvedValueOnce(runWithPacket())
    .mockResolvedValueOnce(packet.response);
  const bounded: TriggerOperation = {
    signal: new AbortController().signal,
    deadline: Date.now() + 10 * TRIGGER_ATTEMPT_TIMEOUT_MS,
  };
  const pending = adapters(fetch)
    .retrieveRun("run_x", bounded)
    .catch((error) => error);
  await jest.advanceTimersByTimeAsync(TRIGGER_ATTEMPT_TIMEOUT_MS);
  expect(await pending).toBeInstanceOf(TriggerRequestError);
  expect(packet.cancelled).toHaveBeenCalled();
});

// Mirrors the installed SDK's parsePacket: exact content type, JSON default,
// other types returned as text, empty data as no payload.
test.each([
  ["application/json", '{"userId":"subject"}', { userId: "subject" }],
  [
    "application/super+json",
    '{"json":{"userId":"subject"},"meta":{}}',
    { userId: "subject" },
  ],
  ["text/plain", "raw packet", "raw packet"],
  [undefined, '{"userId":"subject"}', { userId: "subject" }],
  ["application/json", "", undefined],
])(
  "a presigned %s packet decodes like the Trigger SDK",
  async (type, text, payload) => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(runWithPacket())
      .mockResolvedValueOnce(
        // A byte body carries no implicit content type.
        new Response(new TextEncoder().encode(text), {
          headers: type ? { "content-type": type } : {},
        }),
      );
    await expect(
      adapters(fetch).retrieveRun("run_x", operation),
    ).resolves.toMatchObject({ payload });
  },
);
