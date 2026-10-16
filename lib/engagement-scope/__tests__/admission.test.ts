import { recordUserScope } from "../admission";
import { getConvexClient } from "@/lib/db/convex-client";
import { generateText } from "ai";
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("@/lib/ai/providers", () => ({
  myProvider: { languageModel: jest.fn() },
  resolveTierToProviderKey: () => "existing-standard-model",
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
