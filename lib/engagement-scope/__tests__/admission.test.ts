import { recordUserScope, retryUserScope } from "../admission";
import { getConvexClient } from "@/lib/db/convex-client";
import { generateText } from "ai";
import { SourceEvidenceError } from "../extract";
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("@/lib/ai/providers", () => ({
  myProvider: { languageModel: jest.fn() },
  resolveAgentTierToProviderKey: () => "existing-standard-model",
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));
jest.mock("ai", () => ({
  generateText: jest.fn(),
  Output: { object: jest.fn() },
}));
const mutate = jest.fn();
const current = {
  rules: [
    { target: "example.test", effect: "allow", activity: "active_testing" },
  ],
  restrictions: [],
  clarification: "",
};
beforeEach(() => {
  jest.clearAllMocks();
  (getConvexClient as jest.Mock).mockReturnValue({ mutation: mutate });
});
it("uses the persisted source, commits source-backed edits, and never sends tool output to the extractor", async () => {
  const sourceText = "Also test https://api.example.test:8443";
  mutate
    .mockResolvedValueOnce({
      complete: false,
      revision: 3,
      sourceText,
      current,
    })
    .mockResolvedValueOnce(true);
  (generateText as jest.Mock).mockResolvedValue({
    output: {
      changes: [
        {
          operation: "add",
          rule: {
            target: "https://api.example.test:8443",
            effect: "allow",
            activity: "active_testing",
          },
          evidence: sourceText,
        },
      ],
      restrictions: [],
      clarification: "",
    },
    usage: {},
  });
  await recordUserScope({ userId: "owner", chatId: "chat", messageId: "m2" });
  const prompt = JSON.parse(
    (generateText as jest.Mock).mock.calls[0][0].prompt,
  );
  expect(prompt).toEqual({
    current: { rules: current.rules, restrictions: [] },
    clarification: "",
    userMessage: sourceText,
  });
  expect(mutate.mock.calls[1][1]).toMatchObject({
    expectedRevision: 3,
    unavailable: false,
    policy: {
      rules: [
        ...current.rules,
        {
          target: "https://api.example.test:8443",
          effect: "allow",
          activity: "active_testing",
        },
      ],
    },
  });
});
it("persists unavailable state after extraction failure while retaining the previous rules", async () => {
  mutate
    .mockResolvedValueOnce({
      complete: false,
      revision: 3,
      sourceText: "Remove api.example.test",
      current,
    })
    .mockResolvedValueOnce(true);
  (generateText as jest.Mock).mockRejectedValue(new Error("provider failed"));
  await recordUserScope({ userId: "owner", chatId: "chat", messageId: "m2" });
  expect(mutate.mock.calls[1][1]).toMatchObject({
    unavailable: true,
    policy: { rules: current.rules },
  });
});

it.each([
  ["output getter", "no_output_generated"],
  ["object generation", "no_object_generated"],
  ["schema", "invalid_extraction_schema"],
  ["evidence", "scope_evidence_missing"],
  ["unknown", "unclassified"],
  ["hostile error", "unclassified"],
  ["hostile evidence check", "unclassified"],
  ["private evidence check", "unclassified"],
] as const)(
  "logs a bounded reason for %s failures without leaking content or losing the previous policy",
  async (failure, reason) => {
    const privateText = "private-scope.example.test secret-model-output";
    const chatId = "7a9b7541-4280-4670-b9b3-2d0442f5e68a";
    const messageId = "60655972-17c4-46cb-b827-7ee81caf040b";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mutate
        .mockResolvedValueOnce({
          complete: false,
          revision: 3,
          sourceText: privateText,
          current,
        })
        .mockResolvedValueOnce(true);
      const error = new Error(privateText);
      if (failure === "output getter") error.name = "AI_NoOutputGeneratedError";
      if (failure === "object generation")
        error.name = "AI_NoObjectGeneratedError";
      if (failure === "hostile error")
        Object.defineProperty(error, "name", {
          get: () => {
            throw new Error(privateText);
          },
        });
      if (
        failure === "hostile evidence check" ||
        failure === "private evidence check"
      ) {
        Object.setPrototypeOf(error, SourceEvidenceError.prototype);
        Object.defineProperty(error, "check", {
          get: () => {
            if (failure === "hostile evidence check")
              throw new Error(privateText);
            return privateText;
          },
        });
      }
      if (
        failure === "unknown" ||
        failure === "hostile error" ||
        failure === "hostile evidence check" ||
        failure === "private evidence check" ||
        failure === "object generation"
      ) {
        (generateText as jest.Mock).mockRejectedValue(error);
      } else {
        (generateText as jest.Mock).mockResolvedValue({
          get output() {
            if (failure === "output getter") throw error;
            if (failure === "schema") return { privateText };
            return {
              changes: [
                {
                  operation: "add",
                  rule: {
                    target: "another-private.example.test",
                    effect: "allow",
                    activity: "active_testing",
                  },
                  evidence: privateText,
                },
              ],
              restrictions: [],
              clarification: "",
            };
          },
        });
      }
      await recordUserScope({ userId: "owner", chatId, messageId });
      expect(warn).toHaveBeenCalledWith("engagement_scope_extraction_failed", {
        stage:
          failure === "unknown" ||
          failure === "hostile error" ||
          failure === "hostile evidence check" ||
          failure === "private evidence check" ||
          failure === "object generation"
            ? "generation"
            : "validation",
        timedOut: false,
        reason,
        evidence_check: failure === "evidence" ? "scope_target" : null,
        chat_id: chatId,
        message_id: messageId,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(privateText);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        "another-private.example.test",
      );
      expect(mutate.mock.calls[1][1]).toMatchObject({
        unavailable: true,
        policy: { rules: current.rules, restrictions: current.restrictions },
      });
    } finally {
      warn.mockRestore();
    }
  },
);

it.each([
  ["scope_source", "scope_evidence_missing"],
  ["scope_target", "scope_evidence_missing"],
  ["restriction_source", "restriction_evidence_missing"],
  ["restriction_text", "restriction_evidence_missing"],
] as const)(
  "identifies the %s evidence check while preserving unavailable state and private content",
  async (check, reason) => {
    const sourceText = "Test private.example.test with no private-enumeration";
    const absentText = "invented-private.example.test";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mutate
        .mockResolvedValueOnce({
          complete: false,
          revision: 3,
          sourceText,
          current,
        })
        .mockResolvedValueOnce(true);
      (generateText as jest.Mock).mockResolvedValue({
        output: {
          changes: check.startsWith("scope")
            ? [
                {
                  operation: "add",
                  rule: {
                    target: absentText,
                    effect: "allow",
                    activity: "active_testing",
                  },
                  evidence: check === "scope_source" ? absentText : sourceText,
                },
              ]
            : [],
          restrictions: check.startsWith("restriction")
            ? [
                {
                  operation: "add",
                  text: absentText,
                  evidence:
                    check === "restriction_source" ? absentText : sourceText,
                },
              ]
            : [],
          clarification: "",
        },
      });
      await recordUserScope({
        userId: "owner",
        chatId: "chat",
        messageId: "m2",
      });
      expect(warn).toHaveBeenCalledWith("engagement_scope_extraction_failed", {
        stage: "validation",
        timedOut: false,
        reason,
        evidence_check: check,
        chat_id: null,
        message_id: null,
      });
      expect(mutate.mock.calls[1][1]).toMatchObject({
        expectedRevision: 3,
        unavailable: true,
        policy: { rules: current.rules, restrictions: current.restrictions },
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sourceText);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(absentText);
    } finally {
      warn.mockRestore();
    }
  },
);

it("omits non-UUID identifiers rather than logging arbitrary caller strings", async () => {
  const privateText = "private identifier or target";
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    mutate
      .mockResolvedValueOnce({
        complete: false,
        revision: 3,
        sourceText: privateText,
        current,
      })
      .mockResolvedValueOnce(true);
    (generateText as jest.Mock).mockRejectedValue(privateText);
    await recordUserScope({
      userId: "owner",
      chatId: privateText,
      messageId: privateText,
    });
    expect(warn).toHaveBeenCalledWith(
      "engagement_scope_extraction_failed",
      expect.objectContaining({
        reason: "non_error",
        chat_id: null,
        message_id: null,
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateText);
    expect(mutate.mock.calls[1][1]).toMatchObject({ unavailable: true });
  } finally {
    warn.mockRestore();
  }
});
it("does not extract again for a duplicate or ordinary continuation", async () => {
  mutate.mockResolvedValueOnce({ complete: true });
  await recordUserScope({ userId: "owner", chatId: "chat", messageId: "m1" });
  expect(generateText).not.toHaveBeenCalled();
  mutate
    .mockResolvedValueOnce({
      complete: false,
      revision: 3,
      sourceText: "continue",
      current,
    })
    .mockResolvedValueOnce(true);
  await recordUserScope({ userId: "owner", chatId: "chat", messageId: "m2" });
  expect(generateText).not.toHaveBeenCalled();
  expect(mutate.mock.calls[2][1]).toMatchObject({
    policy: { rules: current.rules },
    unavailable: false,
  });
});

it("regeneration recovers only the backend-selected pending source and skips settled scope", async () => {
  const query = jest
    .fn()
    .mockResolvedValueOnce("pending-human-message")
    .mockResolvedValueOnce(null);
  (getConvexClient as jest.Mock).mockReturnValue({ query, mutation: mutate });
  mutate.mockResolvedValue({ complete: true });
  await retryUserScope({ userId: "owner", chatId: "chat" });
  expect(mutate).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ messageId: "pending-human-message" }),
  );
  mutate.mockClear();
  await retryUserScope({ userId: "owner", chatId: "chat" });
  expect(mutate).not.toHaveBeenCalled();
  expect(generateText).not.toHaveBeenCalled();
});

it("returns a safe actionable API error for a failed save or recovery query", async () => {
  mutate.mockRejectedValueOnce(new Error("internal secret database details"));
  await expect(
    recordUserScope({ userId: "owner", chatId: "chat", messageId: "m2" }),
  ).rejects.toMatchObject({
    statusCode: 400,
    cause:
      "The scope update could not be saved. Retry this request or edit the saved scope.",
  });
  (getConvexClient as jest.Mock).mockReturnValue({
    query: jest.fn().mockRejectedValue(new Error("internal details")),
  });
  await expect(
    retryUserScope({ userId: "owner", chatId: "chat" }),
  ).rejects.toMatchObject({
    statusCode: 400,
    cause:
      "Saved scope could not be recovered. Retry this request or edit the saved scope.",
  });
});
