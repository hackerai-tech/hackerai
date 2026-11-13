import type { ChatMessage } from "@/types";
import { deriveMessageNavigatorItems } from "@/app/components/message-navigator";
import { deriveChatTimelineRows } from "@/app/components/message-timeline-rows";
import { enrichFrontendExceptionEvent } from "../expected-frontend-exceptions";
import {
  clearMessageNavigatorDiagnostics,
  getMessageNavigatorLengthBucket,
  getRecentMessageNavigatorDiagnostics,
  recordMessageNavigatorNormalizationFailure,
  type MessageNavigatorInputShape,
  type MessageNavigatorLengthBucket,
  type MessageNavigatorNormalizationPhase,
} from "../message-navigator-diagnostics";

let mockOwner: string | null = "owned-user-a";
let mockIdentityFailure = false;
let mockSubscribeFailure = false;
let mockResetObservation: (() => void) | undefined;
let now = 1000;
jest.mock("@/lib/analytics/client", () => ({
  getIdentifiedAnalyticsUserId: () => {
    if (mockIdentityFailure) throw new Error("identity unavailable");
    return mockOwner;
  },
  subscribeAuthenticatedAnalytics: (listener: () => void) => {
    if (mockSubscribeFailure) throw new Error("observer unavailable");
    mockResetObservation = listener;
    return () => {};
  },
}));

const CANARY = "PRIVATE_NAVIGATOR_CANARY";
const OWNER = "owned-user-a";

function conversation(text: string) {
  const messages = [
    { id: "PRIVATE_USER_ID", role: "user", parts: [{ type: "text", text }] },
    {
      id: "PRIVATE_ASSISTANT_ID",
      role: "assistant",
      parts: [{ type: "text", text: "Synthetic answer" }],
    },
  ] as ChatMessage[];
  const rows = deriveChatTimelineRows({
    messages,
    status: "ready",
    lastAssistantMessageIndex: undefined,
    expandedAgentMessageIds: new Set(),
  });
  return { messages, rows };
}

/** Replace one String method for canary text only while `run` executes. */
function withCanaryStringMethod<T>(
  method: "replace" | "trim",
  canaryResult: () => unknown,
  run: () => T,
): T {
  const prototype = String.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const actual = prototype[method];
  prototype[method] = function (this: unknown, ...args: unknown[]) {
    if (typeof this === "string" && this.includes(CANARY))
      return canaryResult();
    return actual.apply(this, args);
  };
  try {
    return run();
  } finally {
    prototype[method] = actual;
  }
}

function failDerive(
  method: "replace" | "trim",
  text: string,
  original: unknown,
  derive = deriveMessageNavigatorItems,
) {
  const { messages, rows } = conversation(text);
  return withCanaryStringMethod(
    method,
    () => {
      throw original;
    },
    () => {
      try {
        derive(messages, rows);
      } catch (error) {
        return error;
      }
      return undefined;
    },
  );
}

const stackEvent = () => ({
  event: "$exception",
  properties: {
    $exception_list: [{ type: "InternalError", value: "too much recursion" }],
  } as Record<string, unknown>,
});

beforeEach(() => {
  clearMessageNavigatorDiagnostics();
  mockOwner = OWNER;
  mockIdentityFailure = false;
  mockSubscribeFailure = false;
  now = 1000;
  jest.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

it.each([
  [0, "empty"],
  [1, "le255"],
  [255, "le255"],
  [256, "le4095"],
  [4095, "le4095"],
  [4096, "le65535"],
  [65535, "le65535"],
  [65536, "le1048575"],
  [1048575, "le1048575"],
  [1048576, "ge1048576"],
  [-1, "unknown"],
  [1.5, "unknown"],
  [Number.NaN, "unknown"],
  [Number.POSITIVE_INFINITY, "unknown"],
])("maps UTF-16 length %s to the closed bucket %s", (length, bucket) => {
  expect(getMessageNavigatorLengthBucket(length)).toBe(bucket);
});

it("records nothing for successful normalization", () => {
  const { messages, rows } = conversation(`  ${CANARY}\n\ttext  `);
  expect(deriveMessageNavigatorItems(messages, rows)).toEqual([
    expect.objectContaining({ userText: `${CANARY} text` }),
  ]);
  expect(getRecentMessageNavigatorDiagnostics(OWNER)).toEqual({});
});

it("keeps a nullish replace result failing at trim, as the optional chain did", () => {
  const { messages, rows } = conversation(`${CANARY} text`);
  const reference = withCanaryStringMethod(
    "replace",
    () => undefined,
    () => {
      try {
        const text: string | undefined = `${CANARY} text`;
        return text?.replace(/\s+/g, " ").trim() ?? "";
      } catch (error) {
        return error;
      }
    },
  );
  const actual = withCanaryStringMethod(
    "replace",
    () => undefined,
    () => {
      try {
        deriveMessageNavigatorItems(messages, rows);
      } catch (error) {
        return error;
      }
    },
  );
  expect(reference).toBeInstanceOf(TypeError);
  expect(actual).toBeInstanceOf(TypeError);
  expect(getRecentMessageNavigatorDiagnostics(OWNER)).toMatchObject({
    hackerai_recent_navigator_phase: "trim_whitespace",
    hackerai_recent_navigator_length_bucket: "le255",
  });
});

it("requires the explicit committed owner and the same identified owner", () => {
  const original = new Error("too much recursion");
  expect(failDerive("replace", `${CANARY} text`, original)).toBe(original);
  expect(getRecentMessageNavigatorDiagnostics(OWNER)).toMatchObject({
    hackerai_recent_navigator_phase: "replace_whitespace",
  });
  // A stale or missing committed owner discards the observation entirely.
  expect(getRecentMessageNavigatorDiagnostics("owned-user-b")).toEqual({});
  expect(getRecentMessageNavigatorDiagnostics(OWNER)).toEqual({});

  failDerive("replace", `${CANARY} text`, original);
  expect(getRecentMessageNavigatorDiagnostics(null)).toEqual({});
  expect(getRecentMessageNavigatorDiagnostics(OWNER)).toEqual({});

  // An identity change in between cannot be undone by switching back.
  failDerive("replace", `${CANARY} text`, original);
  mockOwner = "owned-user-b";
  expect(getRecentMessageNavigatorDiagnostics("owned-user-b")).toEqual({});
  mockOwner = OWNER;
  expect(getRecentMessageNavigatorDiagnostics(OWNER)).toEqual({});
});

it("does not retain a failure from before identification", () => {
  mockOwner = null;
  failDerive("trim", `${CANARY} text`, new Error("too much recursion"));
  mockOwner = OWNER;
  expect(getRecentMessageNavigatorDiagnostics(OWNER)).toEqual({});
});

it("clears on an analytics identity notification and on explicit reset", () => {
  failDerive("trim", `${CANARY} text`, new Error("too much recursion"));
  expect(mockResetObservation).toEqual(expect.any(Function));
  mockResetObservation!();
  expect(getRecentMessageNavigatorDiagnostics(OWNER)).toEqual({});

  failDerive("trim", `${CANARY} text`, new Error("too much recursion"));
  clearMessageNavigatorDiagnostics();
  expect(getRecentMessageNavigatorDiagnostics(OWNER)).toEqual({});
});

it.each([6000, 999, Number.NaN])(
  "expires or discards an invalid observation age: %s",
  (next) => {
    failDerive("replace", `${CANARY} text`, new Error("too much recursion"));
    now = next;
    expect(getRecentMessageNavigatorDiagnostics(OWNER)).toEqual({});
    now = 1001;
    expect(getRecentMessageNavigatorDiagnostics(OWNER)).toEqual({});
  },
);

it.each(["subscription", "identity", "clock"] as const)(
  "rethrows the original error unchanged when the %s fails",
  (failure) => {
    // A fresh module subscribes again; keep the shared module's listener.
    const sharedReset = mockResetObservation;
    try {
      jest.isolateModules(() => {
        const { deriveMessageNavigatorItems: derive } =
          require("@/app/components/message-navigator") as typeof import("@/app/components/message-navigator");
        const { getRecentMessageNavigatorDiagnostics: read } =
          require("../message-navigator-diagnostics") as typeof import("../message-navigator-diagnostics");
        if (failure === "subscription") mockSubscribeFailure = true;
        if (failure === "identity") mockIdentityFailure = true;
        if (failure === "clock")
          jest.mocked(performance.now).mockImplementation(() => {
            throw new Error("clock unavailable");
          });
        const original = Object.freeze(new Error("too much recursion"));
        expect(failDerive("replace", `${CANARY} text`, original, derive)).toBe(
          original,
        );
        mockSubscribeFailure = false;
        mockIdentityFailure = false;
        jest.mocked(performance.now).mockImplementation(() => now);
        expect(read(OWNER)).toEqual({});
      });
    } finally {
      mockSubscribeFailure = false;
      mockIdentityFailure = false;
      mockResetObservation = sharedReset;
    }
  },
);

it("rethrows non-Error thrown values unchanged", () => {
  const original = { reason: "PRIVATE_THROWN_OBJECT" };
  expect(failDerive("trim", `${CANARY} text`, original)).toBe(original);
  expect(getRecentMessageNavigatorDiagnostics(OWNER)).toMatchObject({
    hackerai_recent_navigator_phase: "trim_whitespace",
  });
});

it("accepts only consistent closed values at the recorder boundary", () => {
  recordMessageNavigatorNormalizationFailure(
    "replace_whitespace",
    "other",
    "unknown",
  );
  expect(getRecentMessageNavigatorDiagnostics(OWNER)).toMatchObject({
    hackerai_recent_navigator_input_shape: "other",
    hackerai_recent_navigator_length_bucket: "unknown",
  });

  const getter = jest.fn(() => "replace_whitespace");
  const invalid: Array<[unknown, unknown, unknown]> = [
    ["replace_whitespace", "string", "unknown"],
    ["replace_whitespace", "other", "le255"],
    ["PRIVATE_PHASE", "string", "le255"],
    ["trim_whitespace", "PRIVATE_SHAPE", "le255"],
    ["trim_whitespace", "string", 12345],
    [Object.defineProperty({}, "phase", { get: getter }), "string", "le255"],
  ];
  for (const [phase, shape, bucket] of invalid) {
    // A valid earlier observation is not left to describe a later failure.
    recordMessageNavigatorNormalizationFailure(
      "trim_whitespace",
      "string",
      "le255",
    );
    recordMessageNavigatorNormalizationFailure(
      phase as MessageNavigatorNormalizationPhase,
      shape as MessageNavigatorInputShape,
      bucket as MessageNavigatorLengthBucket,
    );
    expect(getRecentMessageNavigatorDiagnostics(OWNER)).toEqual({});
  }
  expect(getter).not.toHaveBeenCalled();
});

describe("exception enrichment", () => {
  const navigatorKeys = (properties: Record<string, unknown>) =>
    Object.keys(properties).filter((key) =>
      key.startsWith("hackerai_recent_navigator_"),
    );

  it("attaches only to stack overflows for the committed owner", () => {
    failDerive("replace", `${CANARY} text`, new Error("too much recursion"));
    // Existing callers without an owner attach nothing and discard the context.
    expect(
      navigatorKeys(enrichFrontendExceptionEvent(stackEvent()).properties),
    ).toEqual([]);
    expect(getRecentMessageNavigatorDiagnostics(OWNER)).toEqual({});

    failDerive("replace", `${CANARY} text`, new Error("too much recursion"));
    const unrelated = enrichFrontendExceptionEvent(
      {
        event: "$exception",
        properties: {
          $exception_values: ["Unrelated failure"],
          hackerai_recent_navigator_phase: "PRIVATE_STALE",
        },
      },
      { navigatorDiagnosticOwner: OWNER },
    );
    expect(navigatorKeys(unrelated.properties)).toEqual([]);

    const original = stackEvent();
    const list = original.properties.$exception_list;
    const enriched = enrichFrontendExceptionEvent(original, {
      navigatorDiagnosticOwner: OWNER,
    });
    expect(enriched.properties).toMatchObject({
      hackerai_exception_category: "stack_overflow",
      hackerai_recent_navigator_phase: "replace_whitespace",
      hackerai_recent_navigator_association: "nearby_only",
    });
    expect(JSON.stringify(enriched)).not.toContain("PRIVATE");

    // Reprocessing after a reset removes every earlier navigator field.
    mockResetObservation!();
    const reprocessed = enrichFrontendExceptionEvent(enriched, {
      navigatorDiagnosticOwner: OWNER,
    });
    expect(navigatorKeys(reprocessed.properties)).toEqual([]);
    expect(reprocessed.properties.$exception_list).toBe(list);
  });
});
