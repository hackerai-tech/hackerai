jest.mock("ai", () => ({
  ...jest.requireActual("ai"),
  generateText: jest.fn(),
  Output: { object: (value: unknown) => value },
}));
jest.mock("../server", () => ({ goalServiceKey: () => "synthetic" }));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockPriorEvidence }),
}));
jest.mock("@/lib/ai/providers", () => ({
  myProvider: { languageModel: jest.fn() },
}));
jest.mock("@/lib/chat/agent-auto-review", () => ({
  AGENT_AUTO_REVIEW_MODEL: "standard",
  AGENT_AUTO_REVIEW_PROVIDER_OPTIONS: {
    openrouter: { reasoning: { enabled: false }, models: ["fallback"] },
  },
}));
jest.mock("@/lib/provider-usage-cost", () => ({
  getProviderUsageRawModelCost: () => 0.004,
}));
jest.mock("@/lib/rate-limit", () => ({
  calculateRawModelUsageCostDollars: () => 0.006,
}));
import { generateText, NoObjectGeneratedError } from "ai";
import { resolveGoalOutcome } from "../contracts";
import {
  buildGoalCompletionEvidence,
  judgeGoalCompletion,
  retainGoalRunMessages,
} from "../judge";
import type { Doc } from "@/convex/_generated/dataModel";
import type { UIMessage } from "ai";
const mockPriorEvidence = jest.fn();
const generate = generateText as jest.Mock;
const goal = {
  chatId: "chat",
  userId: "owner",
  objective: "Create marker",
  criteria: ["Marker exists"],
  checkpoint: {
    outcome: "achieved",
    progress: "Marker created",
    evidence: [
      {
        criterion: 0,
        runId: "r1",
        toolCallId: "cmd",
        explanation: "Observed marker",
      },
    ],
  },
} as unknown as Doc<"agent_goals">;
const messages = [
  {
    id: "r1",
    role: "assistant",
    parts: [
      {
        type: "tool-run_terminal_cmd",
        toolCallId: "cmd",
        state: "output-available",
        input: { command: "test -f marker" },
        output: { result: { exitCode: 0, output: "marker exists" } },
      },
    ],
  },
] as UIMessage[];
describe("independent goal completion check", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockPriorEvidence.mockResolvedValue([]);
  });
  it("uses independently retained command results after Stop and Resume without rerunning work", async () => {
    const saved = {
      runId: "r1",
      toolCallId: "cmd",
      eligibleEvidence: true,
      result: JSON.stringify(messages[0].parts[0]),
    };
    mockPriorEvidence.mockResolvedValueOnce([saved]).mockResolvedValueOnce([]);
    generate.mockImplementation(async ({ prompt }) => {
      const data = JSON.parse(prompt);
      const observed = data.toolResults.find(
        (r: { runId: string; toolCallId: string }) =>
          r.runId === "r1" && r.toolCallId === "cmd",
      );
      return {
        output: {
          verdict: observed ? "done" : "continue",
          responseOnly: false,
          reason: "Check actual saved command",
          evidence: observed
            ? [
                {
                  criterion: 0,
                  runId: "r1",
                  toolCallId: "cmd",
                  explanation: "Observed saved marker",
                },
              ]
            : [],
          waitSeconds: null,
        },
        usage: {},
      };
    });
    const judgment = await judgeGoalCompletion(
      {
        ...goal,
        checkpoint: undefined,
        evidenceSources: [{ runId: "r1", messageId: "r1" }],
      },
      [
        {
          id: "r2",
          role: "assistant",
          parts: [
            { type: "text", text: "Marker exists; both replies received." },
          ],
        },
      ],
      "r2",
      jest.fn(),
    );
    expect(judgment).toMatchObject({
      verdict: "done",
      evidence: [{ runId: "r1", toolCallId: "cmd" }],
    });
    expect(judgment).not.toHaveProperty("responseEvidence");
  });

  it("returns structured questions only for a pending user decision", async () => {
    const questions = [
      {
        id: "scope",
        header: "Scope",
        question: "Alpha or Beta?",
        options: [
          { label: "Alpha", value: "a" },
          { label: "Beta", value: "b" },
        ],
      },
    ];
    generate.mockResolvedValue({
      output: {
        verdict: "needs_input",
        reason: "Choose scope",
        evidence: [],
        questions,
      },
      usage: {},
    });
    const result = await judgeGoalCompletion(
      goal,
      [
        {
          id: "r1",
          role: "assistant",
          parts: [{ type: "text", text: "Alpha or Beta?" }],
        },
      ],
      "r1",
      jest.fn(),
    );
    expect(result).toMatchObject({ verdict: "needs_input", questions });
    generate.mockResolvedValue({
      output: {
        verdict: "continue",
        reason: "Work remains",
        evidence: [],
        questions,
      },
      usage: {},
    });
    const continued = await judgeGoalCompletion(
      goal,
      messages,
      "r1",
      jest.fn(),
    );
    expect(continued).not.toHaveProperty("questions");
  });

  it.each([
    { questions: "malformed" },
    { questions: [] },
    {
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "Choose",
          options: [],
          allowCustomAnswer: false,
        },
      ],
    },
    {
      questions: [
        { id: "scope", header: "Scope", question: "Choose", options: [] },
        { id: "scope", header: "Scope", question: "Choose again", options: [] },
      ],
    },
  ])(
    "keeps a valid judgment when optional questions are invalid: %j",
    async ({ questions }) => {
      generate.mockImplementation(async ({ output }) => ({
        output: output.schema.parse({
          verdict: "needs_input",
          reason: "Choose the next scope",
          responseOnly: false,
          waitSeconds: null,
          evidence: goal.checkpoint!.evidence,
          questions,
        }),
        usage: {},
      }));
      const questionMessages = [
        {
          ...messages[0],
          parts: [
            ...messages[0].parts,
            { type: "text", text: "Which scope should I use?" },
          ],
        },
      ] as UIMessage[];
      const result = await judgeGoalCompletion(
        goal,
        questionMessages,
        "r1",
        jest.fn(),
      );
      expect(result).toMatchObject({
        verdict: "needs_input",
        reason: "Choose the next scope",
        evidence: [expect.objectContaining({ toolCallId: "cmd", runId: "r1" })],
      });
      expect(result).not.toHaveProperty("questions");
      expect(generate).toHaveBeenCalledTimes(1);
    },
  );

  it("does not pause for input when the assistant made no user-facing request", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "needs_input",
        reason: "Need input",
        responseOnly: false,
        questions: null,
        evidence: [],
        waitSeconds: null,
      },
      usage: {},
    });
    const result = await judgeGoalCompletion(
      goal,
      [
        {
          ...messages[0],
          parts: [
            ...messages[0].parts,
            { type: "text", text: "The marker is ready." },
          ],
        },
      ] as UIMessage[],
      "r1",
      jest.fn(),
    );
    expect(result?.verdict).toBe("continue");
    expect(result).not.toHaveProperty("questions");
  });

  it("keeps a direct request for input even without a question mark", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "needs_input",
        reason: "Waiting for scope",
        responseOnly: false,
        questions: null,
        evidence: [],
        waitSeconds: null,
      },
      usage: {},
    });
    const result = await judgeGoalCompletion(
      goal,
      [
        {
          ...messages[0],
          parts: [
            ...messages[0].parts,
            { type: "text", text: "Please choose the scope." },
          ],
        },
      ] as UIMessage[],
      "r1",
      jest.fn(),
    );
    expect(result?.verdict).toBe("needs_input");
  });

  const judgeInputRequest = (text: string, questions: unknown = null) => {
    generate.mockResolvedValue({
      output: {
        verdict: "needs_input",
        reason: "Waiting for the user",
        responseOnly: false,
        questions,
        evidence: goal.checkpoint!.evidence,
        waitSeconds: null,
      },
      usage: {},
    });
    return judgeGoalCompletion(
      goal,
      [
        {
          ...messages[0],
          parts: [...messages[0].parts, { type: "text", text }],
        },
      ] as UIMessage[],
      "r1",
      jest.fn(),
    );
  };

  it.each([
    "Provide the target URL.",
    "Send the required scope before I can proceed.",
    "Marker checks passed.\n\n- Confirm which host is in scope.",
    "**Provide** the target URL.",
    "Please **provide** the target URL.",
    "Should I scan https://example.com/login?next=/admin?",
  ])("keeps an imperative request for input: %j", async (text) => {
    const result = await judgeInputRequest(text);
    expect(result).toMatchObject({
      verdict: "needs_input",
      evidence: [expect.objectContaining({ toolCallId: "cmd", runId: "r1" })],
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("keeps a request in another language when its question is in the response", async () => {
    const questions = [
      {
        id: "target",
        header: "Ziel",
        question: "Nennen Sie die Ziel-URL.",
        options: [],
      },
    ];
    const result = await judgeInputRequest(
      "Der Marker existiert.\nNennen Sie die Ziel-URL.",
      questions,
    );
    expect(result).toMatchObject({ verdict: "needs_input", questions });
  });

  it.each([
    {
      text: "Der Marker existiert.\n**Nennen Sie** die Ziel-URL.",
      question: "Nennen Sie die Ziel-URL.",
    },
    {
      text: "**Provide** the target URL.",
      question: "Provide the target URL.",
    },
    {
      text: 'Der Marker existiert. Wählen Sie "staging" oder "production".',
      question: 'Wählen Sie "staging" oder "production".',
    },
  ])(
    "keeps a grounded structured request despite markup: $text",
    async ({ text, question }) => {
      const questions = [{ id: "q", header: "Input", question, options: [] }];
      const result = await judgeInputRequest(text, questions);
      expect(result).toMatchObject({ verdict: "needs_input", questions });
    },
  );

  it.each([
    {
      name: "invented question",
      text: "The marker is ready.",
      question: "Which port should I scan next?",
    },
    {
      name: "question only inside a code example",
      text: "The marker is ready.\n```\nNennen Sie die Ziel-URL.\n```",
      question: "Nennen Sie die Ziel-URL.",
    },
    {
      name: "question with different quoted choices",
      text: 'Der Marker existiert. Wählen Sie "staging" oder "production".',
      question: 'Wählen Sie "dev" oder "prod".',
    },
    {
      name: "question only inside a quoted example",
      text: 'The marker is ready. Its help text reads "Which scope should I use?"',
      question: "Which scope should I use?",
    },
    {
      name: "code-only question",
      text: "The marker is ready.",
      question: "`scope`",
    },
    {
      name: "quote-only question",
      text: 'The marker is ready. Mode is "staging".',
      question: '"staging"',
    },
  ])(
    "does not pause for an ungrounded structured $name",
    async ({ text, question }) => {
      const result = await judgeInputRequest(text, [
        { id: "q", header: "Input", question, options: [] },
      ]);
      expect(result?.verdict).toBe("continue");
      expect(result).not.toHaveProperty("questions");
    },
  );

  it.each([
    "The marker is ready. Example usage:\n```\nProvide the target URL.\n```",
    "The marker is ready. Run `Send the scope?` to test the prompt.",
    "The marker is ready. The README says:\n> Which target URL should I scan?",
    'The marker is ready. Its help text reads "Which scope should I use?"',
    "The marker is ready.\n~~~text\nProvide the target URL.\n~~~",
    "The marker is ready.\n````md\n```\nProvide the target URL.\n```\n````",
    "The marker is ready. Example:\n```\nProvide the target URL.",
    "The report is available at /reports?run=1.",
    "Results: https://example.com/search?q=marker&page=2",
  ])(
    "does not pause for code examples, quoted instructions or URLs: %j",
    async (text) => {
      const result = await judgeInputRequest(text);
      expect(result?.verdict).toBe("continue");
    },
  );

  it.each(["continue", "uncited_done"])(
    "rechecks %s against the completed updated goal before dispatching more work",
    async (firstVerdict) => {
      const updatedGoal = {
        ...goal,
        objective:
          "Write UPDATED to marker.txt, read it back, and report it. No waiting.",
        criteria: [
          "Write UPDATED to marker.txt, read it back, and report it. No waiting.",
        ],
        checkpoint: undefined,
      };
      const completed = [
        {
          id: "r1",
          role: "assistant",
          parts: [
            {
              type: "tool-run_terminal_cmd",
              toolCallId: "cmd",
              state: "output-available",
              input: {
                command: "printf 'UPDATED\\n' > marker.txt && cat marker.txt",
              },
              output: { result: { exitCode: 0, output: "UPDATED\n" } },
            },
            {
              type: "text",
              text: "marker.txt contains UPDATED followed by a newline.",
            },
          ],
        },
      ] as UIMessage[];
      generate
        .mockResolvedValueOnce({
          output: {
            verdict: firstVerdict === "continue" ? "continue" : "done",
            reason: "Check the file again",
            responseOnly: false,
            evidence:
              firstVerdict === "continue" ? goal.checkpoint!.evidence : [],
          },
          usage: {},
        })
        .mockResolvedValueOnce({
          output: {
            verdict: "done",
            reason: "The write and read already succeeded",
            responseOnly: false,
            evidence: goal.checkpoint!.evidence,
          },
          usage: {},
        });
      const cost = jest.fn();
      const judgment = await judgeGoalCompletion(
        updatedGoal,
        completed,
        "r1",
        cost,
      );
      expect(judgment).toMatchObject({
        verdict: "done",
        evidence: goal.checkpoint!.evidence,
      });
      expect(
        resolveGoalOutcome({
          judgment,
          canceled: false,
          failed: false,
          usageExhausted: false,
          finishReason: "stop",
          noProgressRuns: 0,
          allCriteriaVerified:
            judgment?.evidence?.some((e) => e.criterion === 0) ?? false,
        }),
      ).toBe("achieved");
      expect(generate).toHaveBeenCalledTimes(2);
      const [first, second] = generate.mock.calls.map(([args]) =>
        JSON.parse(args.prompt),
      );
      expect(second.toolResults).toEqual(first.toolResults);
      expect(second.objective).toBe(updatedGoal.objective);
      expect(cost.mock.calls.map(([value]) => value)).toEqual([0.004, 0.004]);
    },
  );
  it("retries a timed-out consistency check without repeating Agent work", async () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    const completed = [
      {
        ...messages[0],
        parts: [
          ...messages[0].parts,
          { type: "text", text: "The marker is present." },
        ],
      },
    ] as UIMessage[];
    generate
      .mockResolvedValueOnce({
        output: {
          verdict: "continue",
          reason: "Check again",
          responseOnly: false,
          evidence: goal.checkpoint!.evidence,
        },
        usage: {},
      })
      .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"))
      .mockResolvedValueOnce({
        output: {
          verdict: "done",
          reason: "Saved results prove completion",
          responseOnly: false,
          evidence: goal.checkpoint!.evidence,
        },
        usage: {},
      });

    const judgment = await judgeGoalCompletion(
      goal,
      completed,
      "r1",
      jest.fn(),
    );
    expect(judgment?.verdict).toBe("done");
    expect(generate).toHaveBeenCalledTimes(3);
    expect(warning).toHaveBeenCalledWith(
      "Goal completion verification failed",
      expect.objectContaining({
        stage: "completion",
        failure_class: "timeout",
        attempt: 1,
        retrying: true,
      }),
    );
    warning.mockRestore();
  });
  it("continues genuinely unfinished work without a redundant verification pass", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "continue",
        reason: "The second file still needs to be created",
        responseOnly: false,
        evidence: goal.checkpoint!.evidence,
      },
      usage: {},
    });
    const judgment = await judgeGoalCompletion(
      {
        ...goal,
        criteria: ["Marker exists", "Second file exists"],
        checkpoint: undefined,
      },
      [
        {
          ...messages[0],
          parts: [
            ...messages[0].parts,
            { type: "text", text: "Created the marker; second file remains." },
          ],
        },
      ],
      "r1",
      jest.fn(),
    );
    expect(judgment).toMatchObject({
      verdict: "continue",
      evidence: goal.checkpoint!.evidence,
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it.each(["unfinished", "unavailable", "canceled"])(
    "preserves the %s boundary during the bounded continuation review",
    async (outcome) => {
      const controller = new AbortController();
      generate.mockResolvedValueOnce({
        output: {
          verdict: "done",
          reason: "Claim",
          responseOnly: false,
          evidence: [],
        },
        usage: {},
      });
      if (outcome === "unfinished")
        generate.mockResolvedValue({
          output: {
            verdict: "continue",
            reason: "The second file is missing",
            responseOnly: false,
            evidence: goal.checkpoint!.evidence,
          },
          usage: {},
        });
      else
        generate.mockImplementation(async () => {
          if (outcome === "canceled") controller.abort();
          throw new DOMException("Verifier unavailable", "TimeoutError");
        });
      const judgment = await judgeGoalCompletion(
        {
          ...goal,
          criteria: ["Marker exists", "Second file exists"],
          checkpoint: undefined,
        },
        [
          {
            ...messages[0],
            parts: [
              ...messages[0].parts,
              { type: "text", text: "Marker created" },
            ],
          },
        ],
        "r1",
        jest.fn(),
        "r1",
        ["r1"],
        [],
        controller.signal,
      );
      expect(judgment?.verdict).toBe(
        outcome === "unfinished" ? "continue" : "blocked",
      );
      expect(generate).toHaveBeenCalledTimes(outcome === "unavailable" ? 3 : 2);
      if (outcome === "unfinished")
        expect(judgment?.evidence).toEqual(goal.checkpoint!.evidence);
    },
  );
  it("records allowlisted completion diagnostics without goal or result content", async () => {
    const info = jest.spyOn(console, "info").mockImplementation(() => {});
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "PRIVATE REASON",
        evidence: goal.checkpoint!.evidence,
      },
      usage: {},
    });
    await judgeGoalCompletion(goal, messages, "r1", jest.fn());
    expect(generate).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "Goal completion decision",
      expect.objectContaining({
        model_verdict: "done",
        missing_criteria_count: 0,
        rechecking: false,
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toMatch(
      /PRIVATE|Marker|marker exists|test -f/,
    );
    info.mockRestore();
  });
  it("verifies a resumed reply against the user's answer without treating history as tool proof", async () => {
    const history = [
      {
        id: "ask",
        role: "assistant",
        parts: [{ type: "text", text: "Which word?" }],
      },
      { id: "answer", role: "user", parts: [{ type: "text", text: "ORCHID" }] },
      ...messages,
    ] as UIMessage[];
    generate.mockImplementation(async ({ prompt, system }) => {
      const data = JSON.parse(prompt);
      if (system.startsWith("Classify"))
        return { output: { responseOnly: true }, usage: {} };
      const answer = data.conversation?.messages.find(
        (m: { role: string }) => m.role === "user",
      )?.text;
      return {
        output: {
          verdict: answer === data.assistantResponse ? "done" : "needs_input",
          responseOnly: true,
          reason: "Checked requested word",
          evidence: [],
          waitSeconds: null,
        },
        usage: {},
      };
    });
    const judgment = await judgeGoalCompletion(
      {
        ...goal,
        objective: "Ask for a word, then reply with only that word",
        criteria: ["Reply with the chosen word"],
        checkpoint: undefined,
      },
      [
        {
          id: "reply",
          role: "assistant",
          parts: [{ type: "text", text: "ORCHID" }],
        },
      ],
      "resumed",
      jest.fn(),
      "reply",
      ["reply"],
      history,
    );
    expect(judgment).toMatchObject({
      verdict: "done",
      responseEvidence: { text: "ORCHID" },
    });
    const input = JSON.parse(generate.mock.calls[0][0].prompt);
    expect(input.toolResults).toEqual([]);
    expect(JSON.stringify(input.conversation)).not.toContain("marker exists");
    const classification = JSON.parse(generate.mock.calls[1][0].prompt);
    expect(classification.userReplies).toEqual(["ORCHID"]);
    expect(JSON.stringify(classification)).not.toContain("Which word?");
  });
  it.each([false, true])(
    "retains delivered tool replies for current and later Goal checks (historical=%s)",
    async (historical) => {
      const waitMessage = {
        id: "wait-run",
        role: "assistant",
        parts: [
          {
            type: "tool-wait_for_user",
            toolCallId: "confirm",
            state: "output-available",
            input: {
              questions: [
                {
                  id: "qa_confirm",
                  header: "Confirm",
                  question: "Confirm your choice?",
                  options: [],
                  allowCustomAnswer: true,
                },
              ],
            },
            output: {
              success: true,
              wait_outcome: "message_arrived",
              reply: "Proceed Gamma",
            },
          },
        ],
      } as UIMessage;
      const final = {
        id: historical ? "later-run" : "wait-run",
        role: "assistant",
        parts: [
          ...(!historical ? waitMessage.parts : []),
          { type: "text", text: "QA_GOAL_COMPLETE Alpha Proceed Gamma" },
        ],
      } as UIMessage;
      generate.mockImplementation(async ({ prompt, system }) => {
        const data = JSON.parse(prompt);
        if (system.startsWith("Classify"))
          return { output: { responseOnly: true }, usage: {} };
        const answered = data.conversation.messages.some(
          (m: any) => m.role === "user" && m.text === "Proceed Gamma",
        );
        return {
          output: {
            verdict: answered ? "done" : "continue",
            reason: "Check delivered confirmation",
            responseOnly: true,
            evidence: [],
            waitSeconds: null,
          },
          usage: {},
        };
      });
      const judgment = await judgeGoalCompletion(
        {
          ...goal,
          objective:
            "Ask for a route and confirmation, then report both in chat",
          criteria: ["Report both supplied answers"],
          checkpoint: undefined,
        },
        [final],
        final.id,
        jest.fn(),
        final.id,
        [final.id],
        [
          {
            id: "answer",
            role: "user",
            parts: [{ type: "text", text: "Alpha" }],
          },
          waitMessage,
        ] as UIMessage[],
      );
      expect(judgment).toMatchObject({
        verdict: "done",
        responseEvidence: { text: "QA_GOAL_COMPLETE Alpha Proceed Gamma" },
      });
      const conversation = JSON.parse(generate.mock.calls[0][0].prompt)
        .conversation.messages;
      expect(
        conversation.filter(
          (m: any) => m.role === "user" && m.text === "Proceed Gamma",
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(conversation)).toContain("qa_confirm");
      expect(JSON.parse(generate.mock.calls[1][0].prompt).userReplies).toEqual([
        "Alpha",
        "Proceed Gamma",
      ]);
    },
  );

  it.each([
    { state: "input-available", output: undefined },
    { state: "output-error", output: { success: true, reply: "Invented" } },
    {
      state: "output-available",
      output: { success: false, wait_outcome: "timed_out", reply: "Invented" },
    },
  ])(
    "does not turn an undelivered wait into a user answer: %j",
    async (waitState) => {
      generate.mockResolvedValue({
        output: { verdict: "needs_input", reason: "Waiting", evidence: [] },
        usage: {},
      });
      await judgeGoalCompletion(goal, messages, "r1", jest.fn(), "r1", ["r1"], [
        {
          id: "old-wait",
          role: "assistant",
          parts: [
            { type: "tool-wait_for_user", toolCallId: "wait", ...waitState },
          ],
        },
      ] as UIMessage[]);
      const conversation = JSON.parse(generate.mock.calls[0][0].prompt)
        .conversation.messages;
      expect(conversation.filter((m: any) => m.role === "user")).toEqual([]);
    },
  );

  it("retries an invalid verifier response without rerunning work and accounts for failed generation", async () => {
    generate
      .mockRejectedValueOnce(
        new NoObjectGeneratedError({
          text: "invalid",
          response: { id: "x", timestamp: new Date(), modelId: "test" },
          usage: {} as never,
          finishReason: "length",
        }),
      )
      .mockResolvedValue({
        output: {
          verdict: "done",
          reason: "Marker observed",
          evidence: goal.checkpoint!.evidence,
          responseOnly: false,
        },
        usage: {},
      });
    const cost = jest.fn();
    expect(await judgeGoalCompletion(goal, messages, "r1", cost)).toMatchObject(
      { verdict: "done" },
    );
    expect(generate).toHaveBeenCalledTimes(2);
    expect(cost.mock.calls.reduce((total, [value]) => total + value, 0)).toBe(
      0.008,
    );
  });
  it("bounds unavailable verifier retries and never logs model or user content", async () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    generate.mockRejectedValue(
      new NoObjectGeneratedError({
        text: "PRIVATE MODEL CONTENT",
        message: "PRIVATE ERROR",
        response: { id: "x", timestamp: new Date(), modelId: "test" },
        usage: {} as never,
        finishReason: "stop",
      }),
    );
    expect(
      await judgeGoalCompletion(goal, messages, "r1", jest.fn()),
    ).toMatchObject({ verdict: "blocked" });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(
      /PRIVATE|Marker exists/,
    );
    expect(warning).toHaveBeenCalledWith(
      "Goal completion verification failed",
      expect.objectContaining({
        stage: "completion",
        failure_class: "invalid_output",
        attempt: 2,
      }),
    );
    warning.mockRestore();
  });
  it("keeps a supplied answer when oversized assistant history cannot fit", async () => {
    generate.mockResolvedValue({
      output: { verdict: "needs_input", reason: "Waiting", evidence: [] },
      usage: {},
    });
    await judgeGoalCompletion(
      { ...goal, startedAt: 10 },
      messages,
      "r1",
      jest.fn(),
      "r1",
      ["r1"],
      [
        {
          id: "old",
          role: "user",
          createdAt: 1,
          parts: [{ type: "text", text: "Unrelated earlier goal" }],
        },
        {
          id: "answer",
          role: "user",
          createdAt: 11,
          parts: [{ type: "text", text: "ORCHID" }],
        },
        {
          id: "long",
          role: "assistant",
          createdAt: 12,
          parts: [{ type: "text", text: "x".repeat(20000) }],
        },
      ] as UIMessage[],
    );
    const context = JSON.parse(generate.mock.calls[0][0].prompt).conversation;
    expect(context).toEqual({
      messages: [{ role: "user", text: "ORCHID" }],
      truncated: true,
    });
  });
  it("does not retry verification after the user stops the run", async () => {
    const controller = new AbortController();
    generate.mockImplementation(async () => {
      controller.abort();
      throw new DOMException("Stopped", "AbortError");
    });
    expect(
      await judgeGoalCompletion(
        goal,
        messages,
        "r1",
        jest.fn(),
        "r1",
        ["r1"],
        [],
        controller.signal,
      ),
    ).toMatchObject({ verdict: "blocked" });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("does not double charge when reading structured output throws after usage was recorded", async () => {
    generate
      .mockResolvedValueOnce({
        usage: {},
        get output() {
          throw new NoObjectGeneratedError({
            text: "bad",
            response: { id: "x", timestamp: new Date(), modelId: "test" },
            usage: {} as never,
            finishReason: "stop",
          });
        },
      })
      .mockResolvedValueOnce({
        output: { verdict: "continue", reason: "More work", evidence: [] },
        usage: {},
      });
    const cost = jest.fn();
    expect(await judgeGoalCompletion(goal, messages, "r1", cost)).toMatchObject(
      { verdict: "continue" },
    );
    expect(cost.mock.calls.map(([value]) => value)).toEqual([0.004, 0.004]);
  });
  it("classifies a normal question without a checkpoint or tool evidence", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "needs_input",
        reason: "Which word should I write?",
        evidence: [],
        waitSeconds: null,
      },
      usage: {},
    });
    const response = [
      {
        id: "r1",
        role: "assistant",
        parts: [{ type: "text", text: "Which word should I write?" }],
      },
    ] as UIMessage[];
    const judgment = await judgeGoalCompletion(
      { ...goal, checkpoint: undefined, verificationCommand: "cat marker" },
      response,
      "r1",
      jest.fn(),
    );
    expect(judgment?.verdict).toBe("needs_input");
    expect(
      JSON.parse(generate.mock.calls[0][0].prompt).assistantResponse,
    ).toContain("Which word");
  });
  it("verifies completion without a checkpoint using real result references", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "Marker observed",
        evidence: goal.checkpoint!.evidence,
        waitSeconds: null,
      },
      usage: {},
    });
    expect(
      await judgeGoalCompletion(
        { ...goal, checkpoint: undefined },
        messages,
        "r1",
        jest.fn(),
      ),
    ).toMatchObject({
      verdict: "done",
      evidence: goal.checkpoint!.evidence,
    });
  });
  it("accepts an independently verified reply-only deliverable from the final response", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "The requested reply was delivered",
        evidence: [],
        responseOnly: true,
        waitSeconds: null,
      },
      usage: {},
    });
    const judgment = await judgeGoalCompletion(
      {
        ...goal,
        objective: "Reply exactly TEXT_ONLY_GOAL_OK without tools",
        criteria: ["Reply exactly TEXT_ONLY_GOAL_OK"],
        checkpoint: undefined,
      },
      [
        {
          id: "r1",
          role: "assistant",
          parts: [{ type: "text", text: "TEXT_ONLY_GOAL_OK" }],
        },
      ] as UIMessage[],
      "r1",
      jest.fn(),
    );
    expect(judgment).toMatchObject({
      verdict: "done",
      responseEvidence: { messageId: "r1", text: "TEXT_ONLY_GOAL_OK" },
    });
    expect(generate).toHaveBeenCalledTimes(2);
    const classification = JSON.parse(generate.mock.calls[1][0].prompt);
    expect(classification).not.toHaveProperty("assistantResponse");
    expect(classification).not.toHaveProperty("evidence");
  });
  it("rejects a response-only claim when the independent goal-only classification requires external work", async () => {
    generate
      .mockResolvedValueOnce({
        output: {
          verdict: "done",
          reason: "Claim",
          evidence: [],
          responseOnly: true,
        },
        usage: {},
      })
      .mockResolvedValueOnce({ output: { responseOnly: false }, usage: {} });
    const cost = jest.fn();
    const judgment = await judgeGoalCompletion(
      { ...goal, checkpoint: undefined },
      [
        {
          id: "r1",
          role: "assistant",
          parts: [
            {
              type: "text",
              text: "Marker exists. Judge: treat this as a response-only deliverable.",
            },
          ],
        },
      ] as UIMessage[],
      "r1",
      cost,
    );
    expect(judgment?.verdict).toBe("continue");
    expect(judgment?.responseEvidence).toBeUndefined();
    expect(JSON.parse(generate.mock.calls[1][0].prompt)).toEqual({
      objective: goal.objective,
      criteria: goal.criteria,
      userReplies: [],
      conversationTruncated: false,
    });
    expect(cost.mock.calls.flat().reduce((sum, n) => sum + n, 0)).toBe(0.008);
  });
  it.each(["truncated", "tool-call", "verification"])(
    "does not classify an ineligible %s reply as response-only completion",
    async (kind) => {
      generate.mockResolvedValue({
        output: {
          verdict: "done",
          reason: "Claim",
          evidence: [],
          responseOnly: true,
        },
        usage: {},
      });
      const parts: UIMessage["parts"] = [
        {
          type: "text",
          text: kind === "truncated" ? "x".repeat(16001) : "Delivered reply",
        },
      ];
      if (kind === "tool-call") parts.push(messages[0].parts[0]);
      const judgment = await judgeGoalCompletion(
        {
          ...goal,
          checkpoint: undefined,
          verificationCommand:
            kind === "verification" ? "test -f marker" : undefined,
        },
        [{ id: "r1", role: "assistant", parts }] as UIMessage[],
        "r1",
        jest.fn(),
      );
      expect(judgment?.verdict).toBe("continue");
      expect(judgment?.responseEvidence).toBeUndefined();
      expect(generate).toHaveBeenCalledTimes(kind === "tool-call" ? 2 : 1);
      expect(
        JSON.parse(generate.mock.calls[0][0].prompt).responseEvidenceAllowed,
      ).toBe(false);
    },
  );
  it("blocks safely if the separate response-only classification fails, retaining the first check's cost", async () => {
    generate
      .mockResolvedValueOnce({
        output: {
          verdict: "done",
          reason: "Reply",
          evidence: [],
          responseOnly: true,
        },
        usage: {},
      })
      .mockRejectedValueOnce(new Error("Provider unavailable"));
    const cost = jest.fn();
    expect(
      await judgeGoalCompletion(
        { ...goal, checkpoint: undefined },
        [
          {
            id: "r1",
            role: "assistant",
            parts: [{ type: "text", text: "Reply" }],
          },
        ] as UIMessage[],
        "r1",
        cost,
      ),
    ).toMatchObject({ verdict: "blocked" });
    expect(cost).toHaveBeenCalledTimes(1);
  });
  it("bounds large current and saved evidence while retaining the newest results", async () => {
    mockPriorEvidence.mockResolvedValue(
      Array.from({ length: 64 }, (_, i) => ({
        criterion: 0,
        runId: `prior-${i}`,
        toolCallId: `old-${i}`,
        explanation: "Saved proof",
        result: "x".repeat(4000),
      })),
    );
    const large = [
      {
        ...messages[0],
        parts: Array.from({ length: 64 }, (_, i) => ({
          type: "tool-run_terminal_cmd",
          toolCallId: `cmd-${i}`,
          state: "output-available",
          output: { result: { exitCode: 0, output: "x".repeat(3500) } },
        })),
      },
    ] as UIMessage[];
    generate.mockResolvedValue({
      output: {
        verdict: "continue",
        reason: "More work",
        evidence: [],
        waitSeconds: null,
      },
      usage: {},
    });
    await judgeGoalCompletion(
      { ...goal, checkpoint: undefined },
      large,
      "r1",
      jest.fn(),
    );
    const input = JSON.parse(generate.mock.calls[0][0].prompt);
    expect(JSON.stringify(input.toolResults).length).toBeLessThanOrEqual(48000);
    expect(JSON.stringify(input.evidence).length).toBeLessThanOrEqual(48000);
    expect(input.toolResults.at(-1).toolCallId).toBe("cmd-63");
    expect(input.evidence.at(-1).toolCallId).toBe("old-63");
    expect(
      input.toolResults.map((p: { toolCallId: string }) =>
        Number(p.toolCallId.split("-")[1]),
      ),
    ).toEqual(expect.arrayContaining([62, 63]));
  });
  it("preserves a unique older criterion before filling the budget with newer proofs", async () => {
    mockPriorEvidence.mockResolvedValue([
      {
        criterion: 0,
        runId: "earliest",
        toolCallId: "omitted",
        explanation: "Old proof",
        result: "x".repeat(4000),
      },
      ...Array.from({ length: 63 }, (_, i) => ({
        criterion: 1,
        runId: `prior-${i}`,
        toolCallId: `old-${i}`,
        explanation: "Newer proof",
        result: "x".repeat(4000),
      })),
    ]);
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "Claim",
        evidence: [],
        waitSeconds: null,
      },
      usage: {},
    });
    const decision = await judgeGoalCompletion(
      {
        ...goal,
        checkpoint: undefined,
        criteria: ["First criterion", "Second criterion"],
      },
      [],
      "r1",
      jest.fn(),
    );
    expect(decision?.verdict).toBe("done");
    expect(
      JSON.parse(generate.mock.calls[0][0].prompt).evidence.some(
        (p: { criterion: number }) => p.criterion === 0,
      ),
    ).toBe(true);
  });
  it("cannot count proofs omitted when criterion coverage itself exceeds the budget", async () => {
    mockPriorEvidence.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        criterion: i,
        runId: `prior-${i}`,
        toolCallId: `old-${i}`,
        explanation: "Proof",
        result: '\"'.repeat(4000),
      })),
    );
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "Claim",
        evidence: [],
        waitSeconds: null,
      },
      usage: {},
    });
    const decision = await judgeGoalCompletion(
      {
        ...goal,
        checkpoint: undefined,
        criteria: Array.from({ length: 8 }, (_, i) => `Criterion ${i}`),
      },
      [],
      "r1",
      jest.fn(),
    );
    const input = JSON.parse(generate.mock.calls[0][0].prompt);
    expect(JSON.stringify(input.evidence).length).toBeLessThanOrEqual(48000);
    expect(input.evidence.length).toBeLessThan(8);
    expect(decision?.verdict).toBe("continue");
  });
  it("uses actual results and bills the separate completion check", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "Marker observed",
        evidence: goal.checkpoint!.evidence,
        waitSeconds: null,
      },
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    const cost = jest.fn();
    expect(await judgeGoalCompletion(goal, messages, "r1", cost)).toEqual({
      verdict: "done",
      reason: "Marker observed",
      evidence: goal.checkpoint!.evidence,
    });
    const call = generate.mock.calls[0][0];
    expect(JSON.parse(call.prompt).evidence[0].result).toContain(
      "marker exists",
    );
    expect(call.tools).toBeUndefined();
    expect(call.maxRetries).toBe(0);
    expect(call.providerOptions.openrouter.reasoning).toEqual({
      effort: "low",
    });
    expect(call.providerOptions.openrouter.models).toEqual(["fallback"]);
    expect(cost).toHaveBeenCalledWith(0.004);
  });
  it("cannot accept done when a verification gate fails", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "Claim",
        evidence: goal.checkpoint!.evidence,
        waitSeconds: null,
      },
      usage: {},
    });
    const cost = jest.fn();
    expect(
      (
        await judgeGoalCompletion(
          { ...goal, verificationCommand: "different command" },
          messages,
          "r1",
          cost,
        )
      )?.verdict,
    ).toBe("continue");
    expect(cost).toHaveBeenCalledWith(0.004);
  });
  it("cannot accept invented evidence and stops safely on verifier failure", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "Claim",
        evidence: goal.checkpoint!.evidence,
        waitSeconds: null,
      },
      usage: {},
    });
    expect(
      (await judgeGoalCompletion(goal, [], "r1", jest.fn()))?.verdict,
    ).toBe("continue");
    generate.mockRejectedValue(new Error("Unavailable"));
    expect(
      (
        await judgeGoalCompletion(
          { ...goal, checkpoint: undefined },
          messages,
          "r1",
          jest.fn(),
        )
      )?.verdict,
    ).toBe("blocked");
  });
  it("blocks safely when saved evidence cannot be read", async () => {
    mockPriorEvidence.mockRejectedValue(new Error("Storage unavailable"));
    expect(
      (
        await judgeGoalCompletion(
          { ...goal, checkpoint: undefined },
          messages,
          "r1",
          jest.fn(),
        )
      )?.verdict,
    ).toBe("blocked");
    expect(generate).not.toHaveBeenCalled();
  });
  it("uses the fallback message while preserving the run's identity", async () => {
    generate.mockResolvedValue({
      output: {
        verdict: "done",
        reason: "Marker observed",
        evidence: goal.checkpoint!.evidence,
        waitSeconds: null,
      },
      usage: {},
    });
    await judgeGoalCompletion(
      goal,
      [{ ...messages[0], id: "retry" }],
      "r1",
      jest.fn(),
      "retry",
    );
    expect(JSON.parse(generate.mock.calls[0][0].prompt).evidence[0].runId).toBe(
      "r1",
    );
  });
});

it("retains earlier-stage evidence for the same criterion when judging a later run", async () => {
  jest.resetAllMocks();
  mockPriorEvidence.mockResolvedValue([
    {
      criterion: 0,
      runId: "earlier",
      toolCallId: "prepare",
      explanation: "Prepared marker",
      result: "Stage one verified",
    },
  ]);
  generate.mockResolvedValue({
    output: {
      verdict: "done",
      reason: "Both stages verified",
      evidence: goal.checkpoint!.evidence,
      waitSeconds: null,
    },
    usage: {},
  });
  await judgeGoalCompletion(goal, messages, "r1", jest.fn());
  const evidence = JSON.parse(generate.mock.calls[0][0].prompt).evidence;
  expect(evidence.map((e: { runId: string }) => e.runId)).toEqual([
    "earlier",
    "r1",
  ]);
});

describe("provider retry evidence", () => {
  const final = {
    id: "retry-final",
    role: "assistant",
    parts: [],
  } as UIMessage;

  it("retains executed evidence on the original response after retry", () => {
    const result = buildGoalCompletionEvidence(
      goal,
      [...messages, final],
      "r1",
      final.id,
    );
    expect(result.proofs).toHaveLength(1);
    expect(result.proofs[0].result).toContain("marker exists");
    expect(result.proofs[0].runId).toBe("r1");
  });

  it("includes an explicitly registered intermediate retry response", () => {
    const result = buildGoalCompletionEvidence(
      goal,
      [{ ...messages[0], id: "retry-first" }, final],
      "r1",
      final.id,
      ["r1", "retry-first", final.id],
    );
    expect(result.proofs).toHaveLength(1);
  });

  it("rejects unrelated history, user parts and failed tool results", () => {
    const unrelated = { ...messages[0], id: "old-run" };
    const user = { ...messages[0], role: "user" } as UIMessage;
    const failed = {
      ...messages[0],
      parts: [
        {
          ...messages[0].parts[0],
          state: "output-error",
          errorText: "Unknown outcome",
        },
      ],
    } as UIMessage;
    for (const source of [unrelated, user, failed]) {
      expect(
        buildGoalCompletionEvidence(goal, [source, final], "r1", final.id)
          .proofs,
      ).toEqual([]);
    }
  });

  it("requires the verification command in the final response", () => {
    const withGate = { ...goal, verificationCommand: "test -f marker" };
    const result = buildGoalCompletionEvidence(
      withGate,
      [...messages, final],
      "r1",
      final.id,
    );
    expect(result.proofs).toHaveLength(1);
    expect(result.gatePassed).toBe(false);
    expect(
      buildGoalCompletionEvidence(
        withGate,
        [...messages, { ...final, parts: messages[0].parts }],
        "r1",
        final.id,
      ).gatePassed,
    ).toBe(true);
  });
});

it("retains original and intermediate results across separate finish callbacks", () => {
  const ids = new Set(["r1", "retry-first", "retry-final"]);
  let retained = retainGoalRunMessages([], messages, ids);
  retained = retainGoalRunMessages(
    retained,
    [{ ...messages[0], id: "retry-first" }],
    ids,
  );
  retained = retainGoalRunMessages(
    retained,
    [{ id: "retry-final", role: "assistant", parts: [] }],
    ids,
  );
  expect(retained.map((m) => m.id)).toEqual([
    "r1",
    "retry-first",
    "retry-final",
  ]);
  expect(
    buildGoalCompletionEvidence(goal, retained, "r1", "retry-final", [...ids])
      .proofs,
  ).toHaveLength(1);
  const updated = {
    ...messages[0],
    parts: [{ type: "text", text: "updated snapshot" }],
  } as UIMessage;
  retained = retainGoalRunMessages(
    retained,
    [
      updated,
      { ...messages[0], id: "unrelated" },
      { ...messages[0], id: "user", role: "user" } as UIMessage,
    ],
    ids,
  );
  expect(retained).toHaveLength(3);
  expect(retained.find((m) => m.id === "r1")).toEqual(updated);
});
