import { assertFreeAgentGates } from "@/lib/api/chat-stream-helpers";
import { ChatSDKError } from "@/lib/errors";

jest.mock("@/lib/db/actions", () => ({
  getNotes: jest.fn(),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

describe("assertFreeAgentGates", () => {
  it("allows free agent mode with a local sandbox", () => {
    expect(() =>
      assertFreeAgentGates({
        mode: "agent",
        subscription: "free",
        sandboxPreference: "desktop",
      }),
    ).not.toThrow();
  });

  it("rejects free agent mode with the cloud sandbox", () => {
    expect(() =>
      assertFreeAgentGates({
        mode: "agent",
        subscription: "free",
        sandboxPreference: "e2b",
      }),
    ).toThrow(ChatSDKError);
  });
});
