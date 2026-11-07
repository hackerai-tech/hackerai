import { resumeAgentLongStream } from "../agent-long-transport";
import { fetchWithErrorHandlers } from "@/lib/utils";
import {
  readTriggerRunStream,
  retrieveTriggerRunStatus,
} from "../trigger-browser-realtime";

jest.mock("@/lib/utils", () => ({ fetchWithErrorHandlers: jest.fn() }));
jest.mock("../trigger-browser-realtime", () => ({
  readTriggerRunStream: jest.fn(),
  retrieveTriggerRunStatus: jest.fn(),
}));

const responseDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "Response",
);
const { Response: FetchResponse } = jest.requireActual(
  "next/dist/compiled/@edge-runtime/primitives/fetch",
);
beforeAll(() =>
  Object.defineProperty(globalThis, "Response", {
    configurable: true,
    value: FetchResponse,
  }),
);
afterAll(() => {
  if (responseDescriptor)
    Object.defineProperty(globalThis, "Response", responseDescriptor);
  else Reflect.deleteProperty(globalThis, "Response");
});

afterEach(() => jest.resetAllMocks());

it.each(["abort", "error"])(
  "stops the actual browser transport at %s and preserves the preceding partial text",
  async (type) => {
    const terminal =
      type === "abort" ? { type } : { type, errorText: "visible failure" };
    const chunks = [
      { type: "start", messageId: "owned-message" },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "partial" },
      terminal,
      { type: "text-delta", id: "text", delta: "late text must not publish" },
      { type: "finish" },
      { type: "data-late", data: "late metadata must not publish" },
    ];
    const next = jest.fn(async () => ({
      done: false as const,
      value: chunks.shift(),
    }));
    jest.mocked(readTriggerRunStream).mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next }),
    } as ReturnType<typeof readTriggerRunStream>);
    jest.mocked(retrieveTriggerRunStatus).mockResolvedValue("EXECUTING");
    jest.mocked(fetchWithErrorHandlers).mockResolvedValue(
      new Response(
        JSON.stringify({
          runId: "owned-run",
          publicAccessToken: "controlled-token",
        }),
      ),
    );
    const onClosed = jest.fn();
    const response = await resumeAgentLongStream(
      "https://qa.invalid/api/agent/resume?chatId=owned-chat",
      undefined,
      onClosed,
    );
    const frames = (await response.text())
      .split("\n\n")
      .filter(Boolean)
      .map((frame) => JSON.parse(frame.slice(6)));
    expect(frames).toEqual([
      { type: "start", messageId: "owned-message" },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "partial" },
      terminal,
    ]);
    expect(next).toHaveBeenCalledTimes(4);
    expect(onClosed).toHaveBeenCalledWith("owned-run");
  },
);
