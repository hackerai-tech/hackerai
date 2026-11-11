import { attachOpenRouterStreamErrorMetadata } from "../providers";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { streamText } from "ai";
import { TextDecoderStream, WritableStream } from "node:stream/web";
import { withOpenRouterStreamErrorContext } from "../openrouter-stream-error-context";
import {
  extractErrorDetails,
  getProviderStatusCode,
  isRetriableProviderStreamDisconnectError,
} from "@/lib/utils/error-utils";
import { recordOpenRouterStreamErrorContext } from "@/lib/utils/openrouter-stream-error-context";

const edge = require("next/dist/compiled/@edge-runtime/primitives/fetch");
const originalResponse = Object.getOwnPropertyDescriptor(
  globalThis,
  "Response",
);
const streamDescriptors = ["TextDecoderStream", "WritableStream"].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
beforeAll(() => {
  Object.defineProperty(globalThis, "Response", {
    configurable: true,
    writable: true,
    value: edge.Response,
  });
  for (const [key, value] of Object.entries({
    TextDecoderStream,
    WritableStream,
  }))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
});
afterAll(() => {
  if (originalResponse)
    Object.defineProperty(globalThis, "Response", originalResponse);
  for (const [key, descriptor] of streamDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const failure = async (error: Error, status = 206) => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const bytes = new Uint8Array([1, 2, 3]);
  const wrapped = attachOpenRouterStreamErrorMetadata(
    new Response(
      new ReadableStream({
        start(c) {
          controller = c;
          c.enqueue(bytes);
        },
      }),
      {
        status,
        headers: { "x-request-id": "req-body", "set-cookie": "PRIVATE_CANARY" },
      },
    ),
  );
  const reader = wrapped.body!.getReader();
  expect((await reader.read()).value).toBe(bytes);
  controller.error(error);
  const caught = await reader.read().catch((e: unknown) => e);
  expect(wrapped.status).toBe(status);
  return caught;
};

it("reports observed response status without replacing operational status or the original error", async () => {
  const error = Object.assign(new TypeError("terminated"), {
    statusCode: 502,
    cause: { code: "ECONNRESET" },
  });
  const before = isRetriableProviderStreamDisconnectError(error);
  const caught = await failure(error);
  expect(caught).toBe(error);
  const details = extractErrorDetails(caught);
  expect(details).toMatchObject({
    statusCode: 502,
    openrouterBodyFailureContextVersion: 1,
    openrouterBodyFailureSource: "response_body",
    openrouterBodyFailureAssociation: "same_response",
    openrouterBodyFailureStatus: 206,
    openrouterBodyFailurePhase: "read_body",
  });
  expect(getProviderStatusCode(details)).toBe(502);
  expect(isRetriableProviderStreamDisconnectError(caught)).toBe(before);
  const diagnostic = Object.fromEntries(
    Object.entries(details).filter(([key]) => key.startsWith("openrouterBody")),
  );
  expect(JSON.stringify(diagnostic)).not.toMatch(
    /PRIVATE|cookie|req-body|terminated/,
  );
});

it("preserves existing frozen-error fallback and marks completion validation separately", async () => {
  const original = Object.freeze(new TypeError("terminated"));
  const caught = await failure(original);
  expect(caught).not.toBe(original);
  expect(caught).toMatchObject({ name: original.name, cause: original });
  expect(extractErrorDetails(caught)).toMatchObject({
    openrouterBodyFailureStatus: 206,
    openrouterBodyFailurePhase: "read_body",
  });
  const response = attachOpenRouterStreamErrorMetadata(
    new Response("data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    }),
    { expectChatCompletion: true },
  );
  const error = await response.text().catch((e: unknown) => e);
  expect(extractErrorDetails(error)).toMatchObject({
    openrouterBodyFailureStatus: 200,
    openrouterBodyFailurePhase: "finish_stream",
  });
});

it("keeps concurrent response ownership separate and permanently censors reused errors", async () => {
  const first = new TypeError("terminated");
  const second = new TypeError("terminated");
  await Promise.all([failure(first, 200), failure(second, 206)]);
  expect(extractErrorDetails(first).openrouterBodyFailureStatus).toBe(200);
  expect(extractErrorDetails(second).openrouterBodyFailureStatus).toBe(206);
  for (const status of [201, 202]) await failure(first, status);
  const details = extractErrorDetails(first);
  expect(details.openrouterBodyFailureAssociation).toBe("ambiguous");
  expect(details.openrouterBodyFailureStatus).toBeUndefined();
  expect(details.openrouterBodyFailurePhase).toBeUndefined();
  expect(
    extractErrorDetails(new AggregateError([first, second], "combined"))
      .openrouterBodyFailureAssociation,
  ).toBe("ambiguous");
});

it("censors a body association when SDK call ownership is ambiguous", async () => {
  const error = new TypeError("terminated");
  await failure(error);
  const context = {
    version: 1,
    source: "sdk_error_part",
    headers: "absent",
    association: "same_call",
  } as const;
  recordOpenRouterStreamErrorContext(error, {}, context);
  recordOpenRouterStreamErrorContext(error, {}, context);
  expect(extractErrorDetails(error).openrouterBodyFailureAssociation).toBe(
    "ambiguous",
  );
  expect(
    extractErrorDetails(error).openrouterBodyFailureStatus,
  ).toBeUndefined();
});

it("does not select one of two independently observed bodies in an aggregate", async () => {
  const first = new TypeError("terminated");
  const second = new TypeError("terminated");
  await Promise.all([failure(first, 200), failure(second, 206)]);
  const details = extractErrorDetails(
    new AggregateError([first, second], "combined"),
  );
  expect(details.openrouterBodyFailureAssociation).toBe("ambiguous");
  expect(details.openrouterBodyFailureStatus).toBeUndefined();
  expect(details.openrouterBodyFailurePhase).toBeUndefined();
  expect(
    extractErrorDetails(new Error("wrapper", { cause: second })),
  ).toMatchObject({
    openrouterBodyFailureStatus: 206,
    openrouterBodyFailureAssociation: "same_response",
  });
});

it("does not invent a body status for an in-band error or alter cancellation", async () => {
  expect(
    extractErrorDetails({ code: 502 }).openrouterBodyFailureStatus,
  ).toBeUndefined();
  const cancel = jest.fn();
  const original = new Response(new ReadableStream({ cancel }));
  const response = attachOpenRouterStreamErrorMetadata(original);
  await response.body!.cancel("owned-cancel");
  expect(cancel).toHaveBeenCalledWith("owned-cancel");
  const nonOk = new Response("failure", { status: 503 });
  expect(attachOpenRouterStreamErrorMetadata(nonOk)).toBe(nonOk);
});

it("retains body evidence through the installed provider and SDK error callback", async () => {
  const original = Object.assign(new TypeError("terminated"), {
    cause: { code: "ECONNRESET" },
  });
  const fetch = jest.fn().mockImplementation(async () =>
    attachOpenRouterStreamErrorMetadata(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(original);
          },
        }),
        { status: 206, headers: { "content-type": "text/event-stream" } },
      ),
    ),
  );
  const errors: unknown[] = [];
  const result = streamText({
    model: withOpenRouterStreamErrorContext(
      createOpenRouter({ apiKey: "owned-unused", fetch }).chat("test"),
    ),
    prompt: "owned fixture",
    maxRetries: 0,
    onError: ({ error }) => {
      errors.push(error);
    },
  });
  const parts = [];
  for await (const part of result.fullStream) parts.push(part);
  expect(errors).toEqual([original]);
  expect(parts.find((part) => part.type === "error")?.error).toBe(original);
  expect(extractErrorDetails(original)).toMatchObject({
    openrouterBodyFailureStatus: 206,
    openrouterBodyFailurePhase: "read_body",
  });
  expect(getProviderStatusCode(extractErrorDetails(original))).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
});
