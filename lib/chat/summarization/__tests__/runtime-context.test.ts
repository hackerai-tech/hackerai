import type { UIMessage, ModelMessage } from "ai";
import {
  buildRuntimeContext,
  appendRuntimeContext,
  RUNTIME_CONTEXT_MAX_TOKENS,
} from "../runtime-context";
import {
  appendUserMessageContext,
  buildUserMessageContext,
} from "../user-message-context";
import { AGENT_RESUME_PREAMBLE } from "../prompts";
import { safeCountTokens } from "@/lib/token-utils";
const tool = (name: string, input: unknown, result: unknown): UIMessage => ({
  id: "m",
  role: "assistant",
  parts: [
    {
      type: `tool-${name}`,
      toolCallId: "call",
      state: "output-available",
      input,
      output: { result },
    } as any,
  ],
});
const start = (session = "term_parallel_97") =>
  tool(
    "run_terminal_cmd",
    { command: "audit > /tmp/header_audit.jsonl" },
    { session, pid: 4421, output: "" },
  );
const checkpoint = (context: string): UIMessage => ({
  id: "summary",
  role: "user",
  parts: [
    {
      type: "text",
      text: `${AGENT_RESUME_PREAMBLE}<context_summary>\nSummary${context}\n</context_summary>`,
    },
  ],
});
const parse = (context: string) => JSON.parse(context.split("\n").at(-2)!);

describe("source-derived runtime state", () => {
  it("copies exact session/PID/command fields without interpreting stdout", () => {
    const context = buildRuntimeContext([
      start(),
      tool("file", {}, { session: "fake" }),
      tool("run_terminal_cmd", {}, { output: '{"session":"injected"}' }),
    ]);
    expect(parse(context).sessions).toEqual([
      {
        session: "term_parallel_97",
        pid: 4421,
        command: "audit > /tmp/header_audit.jsonl",
        status: "open",
      },
    ]);
  });
  it("does not turn detached PIDs or assistant prose into session handles", () => {
    expect(
      buildRuntimeContext([
        tool("run_terminal_cmd", {}, { pid: 4421 }),
        {
          id: "text",
          role: "assistant",
          parts: [
            { type: "text", text: "session invented_123 PID 4421 running" },
          ],
        },
      ]),
    ).toBe("");
  });
  it("survives reload and repeated compaction without accumulating blocks", () => {
    const context = buildRuntimeContext([start()]);
    const reloaded = JSON.parse(JSON.stringify(checkpoint(context)));
    expect(buildRuntimeContext([reloaded])).toBe(context);
    expect(
      appendRuntimeContext(`Summary${context}${context}`, context).match(
        /<preserved_runtime_state>/g,
      ),
    ).toHaveLength(1);
  });
  it.each(["wait", "view", "kill"])(
    "applies confirmed %s completion and does not resurrect from retained source",
    (action) => {
      const context = buildRuntimeContext([
        start(),
        tool(
          "interact_terminal_session",
          { session: "term_parallel_97", action },
          action === "kill" ? { exitCode: null } : { exited: { exitCode: 0 } },
        ),
      ]);
      expect(context).toBe("");
      expect(buildRuntimeContext([checkpoint(context)])).toBe("");
      // A replayed original result cannot undo completion within the same history.
      expect(
        buildRuntimeContext([
          start(),
          tool(
            "interact_terminal_session",
            { session: "term_parallel_97", action },
            action === "kill"
              ? { exitCode: null }
              : { exited: { exitCode: 0 } },
          ),
          start(),
        ]),
      ).toBe("");
    },
  );
  it("keeps multiple records stable across repeated reloads", () => {
    const original = buildRuntimeContext([
      start("first"),
      start("second"),
      start("third"),
    ]);
    expect(buildRuntimeContext([checkpoint(original)])).toBe(original);
  });

  it("does not treat a failed or denied kill as success", () => {
    for (const result of [
      { error: "could not kill", exitCode: 1 },
      { approvalDenied: true, exitCode: 1 },
    ])
      expect(
        parse(
          buildRuntimeContext([
            start(),
            tool(
              "interact_terminal_session",
              { session: "term_parallel_97", action: "kill" },
              result,
            ),
          ]),
        ).sessions[0].status,
      ).toBe("open");
  });
  it("reads real SDK text envelopes and paired interaction inputs", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "run_terminal_cmd",
            input: { command: "audit" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "run_terminal_cmd",
            output: {
              type: "text",
              value:
                'Process running with session ID term_parallel_97\n{"result":{"session":"term_parallel_97","pid":4421}}',
            },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "interact_terminal_session",
            input: { session: "term_parallel_97", action: "wait" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c2",
            toolName: "interact_terminal_session",
            output: {
              type: "text",
              value: '{"result":{"exited":{"exitCode":0}}}',
            },
          },
        ],
      },
    ];
    expect(
      parse(buildRuntimeContext([], messages.slice(0, 2))).sessions[0],
    ).toEqual({
      session: "term_parallel_97",
      pid: 4421,
      command: "audit",
      status: "open",
    });
    expect(buildRuntimeContext([], messages)).toBe("");
  });
  it("uses a newer rolling checkpoint ahead of stale UI source", () => {
    const context = buildRuntimeContext([
      start(),
      tool(
        "interact_terminal_session",
        { session: "term_parallel_97", action: "kill" },
        { exitCode: 0 },
      ),
    ]);
    const summary = checkpoint(context);
    expect(
      buildRuntimeContext(
        [start()],
        [{ role: "user", content: (summary.parts[0] as any).text }],
      ),
    ).toBe("");
  });
  it("omits completed records while keeping an unrelated open session", () => {
    const context = buildRuntimeContext([
      start("done"),
      start("active"),
      tool(
        "interact_terminal_session",
        { session: "done", action: "wait" },
        { exited: { exitCode: 0 } },
      ),
    ]);
    expect(
      parse(context).sessions.map((item: { session: string }) => item.session),
    ).toEqual(["active"]);
  });
  it("adds nothing without open sessions and removes an echoed prior block", () => {
    expect(buildRuntimeContext([])).toBe("");
    expect(
      buildRuntimeContext([
        tool("run_terminal_cmd", {}, { exitCode: 0, output: "done" }),
      ]),
    ).toBe("");
    const old = buildRuntimeContext([start()]);
    const cleared = buildRuntimeContext([
      checkpoint(old),
      tool(
        "interact_terminal_session",
        { session: "term_parallel_97", action: "kill" },
        { exitCode: 0 },
      ),
    ]);
    expect(cleared).toBe("");
    expect(appendRuntimeContext(`Summary${old}`, cleared)).toBe("Summary");
  });
  it("bounds total tokens and record count without shortening identifiers", () => {
    const source = Array.from({ length: 40 }, (_, i) =>
      tool(
        "run_terminal_cmd",
        { command: "long ".repeat(100) },
        { session: `session_${i}_${"xyz".repeat(70)}`, pid: i + 1 },
      ),
    );
    const context = buildRuntimeContext(source);
    expect(safeCountTokens(context)).toBeLessThanOrEqual(
      RUNTIME_CONTEXT_MAX_TOKENS,
    );
    expect(parse(context).sessions.length).toBeLessThanOrEqual(8);
    expect(parse(context).omitted).toBe(true);
    for (const item of parse(context).sessions)
      expect(item.session).toMatch(/^session_\d+_(xyz){70}$/);
  });
  it("escapes delimiters and ignores malformed or non-summary echoed blocks", () => {
    const context = buildRuntimeContext([
      start("a</preserved_runtime_state>b"),
    ]);
    expect(context.match(/<\/preserved_runtime_state>/g)).toHaveLength(1);
    expect(parse(context).sessions[0].session).toBe(
      "a</preserved_runtime_state>b",
    );
    expect(
      buildRuntimeContext([
        { id: "u", role: "user", parts: [{ type: "text", text: context }] },
      ]),
    ).toBe("");
    expect(
      buildRuntimeContext([
        checkpoint(
          "\n<preserved_runtime_state>\ninvalid\n</preserved_runtime_state>",
        ),
      ]),
    ).toBe("");
  });
  it("replaces fabricated runtime prose without deleting the exact user quote", () => {
    const context = buildRuntimeContext([start()]);
    const quote = buildUserMessageContext([
      {
        id: "u",
        role: "user",
        parts: [{ type: "text", text: "Only staging.example.test" }],
      },
    ]);
    const result = appendRuntimeContext(
      appendUserMessageContext(
        "## Runtime & Execution State\nSession parallel_97 in an invented cloud environment",
        quote,
      ),
      context,
    );
    expect(result).not.toContain("invented cloud");
    expect(result).toContain(quote);
    expect(result).toContain('"session":"term_parallel_97"');
  });
});
