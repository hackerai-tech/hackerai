import {
  getCompletedToolSummaryIconCategory,
  isExpandableWorkedForPart,
  projectAgentWorkParts,
  projectAgentWorkTimelineItems,
  splitWorkedForParts,
  summarizeCompletedToolActivities,
} from "../worked-for-parts";
import type { ChatMessage } from "@/types";

type MessagePart = ChatMessage["parts"][number];

const part = (
  type: string,
  extra: Record<string, unknown> = {},
): ChatMessage["parts"][number] =>
  ({
    type,
    ...extra,
  }) as ChatMessage["parts"][number];

describe("splitWorkedForParts", () => {
  it("keeps tool work collapsed and trailing answer text visible", () => {
    const tool = part("tool-shell", { input: "ran command" });
    const text = part("text", { text: "final answer" });

    const result = splitWorkedForParts([tool, text]);

    expect(result.fileParts).toEqual([]);
    expect(result.nonFileParts).toEqual([tool, text]);
    expect(result.workParts).toEqual([tool]);
    expect(result.trailingTextParts).toEqual([text]);
  });

  it("treats stopped tool-only messages as work with no visible answer", () => {
    const tool = part("tool-shell", { input: "ran command" });

    const result = splitWorkedForParts([tool]);

    expect(result.workParts).toEqual([tool]);
    expect(result.trailingTextParts).toEqual([]);
  });

  it("ignores trailing stream metadata after regenerated answer text", () => {
    const tool = part("tool-shell", { input: "ran command" });
    const text = part("text", { text: "regenerated final answer" });
    const metadata = part("data-context-usage", { data: {} });

    const result = splitWorkedForParts([tool, text, metadata]);

    expect(result.workParts).toEqual([tool]);
    expect(result.trailingTextParts).toEqual([text]);
  });

  it("does not ignore rendered data-terminal parts at the tail", () => {
    const text = part("text", { text: "intermediate text" });
    const terminal = part("data-terminal", {
      data: { terminal: "output", toolCallId: "tool-1" },
    });

    const result = splitWorkedForParts([text, terminal]);

    expect(result.workParts).toEqual([text, terminal]);
    expect(result.trailingTextParts).toEqual([]);
  });

  it("separates file parts from worked-for parts", () => {
    const file = part("file", { url: "https://example.com/file.txt" });
    const tool = part("tool-shell", { input: "ran command" });
    const text = part("text", { text: "final answer" });

    const result = splitWorkedForParts([file, tool, text]);

    expect(result.fileParts).toEqual([file]);
    expect(result.nonFileParts).toEqual([tool, text]);
    expect(result.workParts).toEqual([tool]);
    expect(result.trailingTextParts).toEqual([text]);
  });
});

describe("isExpandableWorkedForPart", () => {
  it("treats tool parts and rendered tool output as expandable work", () => {
    expect(isExpandableWorkedForPart(part("tool-shell"))).toBe(true);
    expect(
      isExpandableWorkedForPart(
        part("data-terminal", {
          data: { terminal: "output", toolCallId: "tool-1" },
        }),
      ),
    ).toBe(true);
  });

  it("does not treat stream metadata or non-tool work as expandable work", () => {
    expect(isExpandableWorkedForPart(part("step-start"))).toBe(false);
    expect(isExpandableWorkedForPart(part("data-context-usage"))).toBe(false);
    expect(isExpandableWorkedForPart(part("data-summarization"))).toBe(false);
    expect(isExpandableWorkedForPart(part("reasoning"))).toBe(false);
  });
});

describe("repeated subagent waits", () => {
  const wait = (id: string, extra: Record<string, unknown> = {}) =>
    part("tool-wait_for_agents", {
      toolCallId: id,
      state: "output-available",
      output: { success: true, wait_outcome: "timeout" },
      ...extra,
    });
  const project = (parts: MessagePart[]) =>
    projectAgentWorkParts(
      parts,
      parts.map((_, index) => index),
    ).activities;

  it("keeps one stable status through timeouts and the next live wait", () => {
    const first = wait("wait-1");
    const reasoning = part("reasoning", {
      text: "The child is still working.",
    });
    const second = wait("wait-2");
    const live = wait("wait-3", {
      state: "input-available",
      output: undefined,
    });
    const parts = [
      first,
      part("step-start"),
      reasoning,
      second,
      part("step-start"),
      live,
    ];
    const activities = project(parts);

    expect(activities).toHaveLength(1);
    expect(activities[0].id).toBe(project([first])[0].id);
    expect(activities[0].groupedParts).toEqual([
      { part: first, partIndex: 0 },
      { part: reasoning, partIndex: 2 },
      { part: second, partIndex: 3 },
      { part: live, partIndex: 5 },
    ]);
    expect(parts).toHaveLength(6);
  });

  it("matches target sets regardless of order and keeps changed targets separate", () => {
    const first = wait("one", { input: { target_agent_ids: ["a", "b"] } });
    const same = wait("two", { input: { target_agent_ids: ["b", "a"] } });
    const changed = wait("three", { input: { target_agent_ids: ["a"] } });
    const activities = project([first, same, changed, wait("all")]);
    expect(activities).toHaveLength(3);
    expect(activities[0].groupedParts?.map(({ part }) => part)).toEqual([
      first,
      same,
    ]);
  });

  it.each([
    part("text", { text: "Here is an update." }),
    part("tool-shell", { toolCallId: "command", state: "output-available" }),
    part("data-summarization", { data: {} }),
    wait("progress", { output: { success: true, wait_outcome: "progress" } }),
    wait("completed", {
      output: { success: true, wait_outcome: "agent_finished" },
    }),
    wait("missing", {
      output: { success: false, wait_outcome: "targets_not_found" },
    }),
    wait("failed", { state: "output-error", errorText: "Connection failed" }),
  ])(
    "does not group across meaningful activity: $type $toolCallId",
    (boundary) => {
      const first = wait("one");
      const last = wait("two");
      const activities = project([first, boundary, last]);
      expect(activities).toHaveLength(3);
      expect(activities[1].part).toBe(boundary);
    },
  );

  it("leaves reasoning after the last wait in place", () => {
    const reasoning = part("reasoning", {
      text: "I should try another approach.",
    });
    const activities = project([wait("one"), wait("two"), reasoning]);
    expect(activities).toHaveLength(2);
    expect(activities[1].part).toBe(reasoning);
  });

  it("does not merge simultaneous live waits or incomplete arguments", () => {
    const activities = project([
      wait("one", { state: "input-available", output: undefined }),
      wait("two", { state: "input-available", output: undefined }),
      wait("three", { state: "input-streaming", output: undefined }),
    ]);
    expect(activities).toHaveLength(3);
  });

  it("uses the latest tool snapshot and groups identically after reload", () => {
    const first = wait("one", { state: "input-available", output: undefined });
    const finalFirst = wait("one");
    const second = wait("two");
    const activities = project([first, finalFirst, second]);
    expect(activities).toHaveLength(1);
    expect(activities[0].groupedParts?.map(({ part }) => part)).toEqual([
      finalFirst,
      second,
    ]);
    expect(
      project(JSON.parse(JSON.stringify([finalFirst, second])))[0].id,
    ).toBe(activities[0].id);
  });
});

describe("projectAgentWorkTimelineItems", () => {
  it("summarizes a closed successful step in execution order", () => {
    const parts = [
      part("step-start"),
      part("tool-read_file", {
        toolCallId: "read-1",
        state: "output-available",
        output: "file contents",
      }),
      part("tool-shell", {
        toolCallId: "shell-1",
        state: "output-available",
        output: "done",
      }),
      part("step-start"),
      part("reasoning", { text: "next step" }),
    ];
    const { workPartIndexes } = splitWorkedForParts(parts);
    const projection = projectAgentWorkParts(parts, workPartIndexes);

    const items = projectAgentWorkTimelineItems({
      activities: projection.activities,
      messageSettled: false,
      parts,
      workPartIndexes,
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "tool-group",
      settled: true,
      summary: "Read a file, ran a command",
    });
    expect(items[1]).toMatchObject({ kind: "activity" });
  });

  it("keeps the current step in one unsettled group while streaming", () => {
    const parts = [
      part("step-start"),
      part("tool-read_file", {
        toolCallId: "read-1",
        state: "output-available",
      }),
      part("tool-shell", {
        toolCallId: "shell-1",
        state: "output-available",
      }),
    ];
    const { workPartIndexes } = splitWorkedForParts(parts);
    const projection = projectAgentWorkParts(parts, workPartIndexes);

    const items = projectAgentWorkTimelineItems({
      activities: projection.activities,
      messageSettled: false,
      parts,
      workPartIndexes,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool-group", settled: false });
    expect(items[0]?.kind === "tool-group" && items[0].activities).toHaveLength(
      2,
    );
  });

  it("keeps the same group id from the first tool call through settlement", () => {
    const firstTool = part("tool-read_file", {
      toolCallId: "read-1",
      state: "input-streaming",
    });
    const project = (parts: MessagePart[], messageSettled: boolean) => {
      const { workPartIndexes } = splitWorkedForParts(parts);
      const projection = projectAgentWorkParts(parts, workPartIndexes);
      return projectAgentWorkTimelineItems({
        activities: projection.activities,
        messageSettled,
        parts,
        workPartIndexes,
      });
    };

    const streamingFirstTool = project([part("step-start"), firstTool], false);
    const streamingSecondTool = project(
      [
        part("step-start"),
        { ...firstTool, state: "output-available" },
        part("tool-read_file", {
          toolCallId: "read-2",
          state: "input-available",
        }),
      ] as MessagePart[],
      false,
    );
    const settledRun = project(
      [
        part("step-start"),
        { ...firstTool, state: "output-available" },
        part("tool-read_file", {
          toolCallId: "read-2",
          state: "output-available",
        }),
        part("step-start"),
        part("reasoning", { text: "next step" }),
      ] as MessagePart[],
      false,
    );

    expect(streamingFirstTool[0]).toMatchObject({
      kind: "tool-group",
      id: "tool-group:0:tool:read-1",
      settled: false,
    });
    expect(streamingSecondTool[0]).toMatchObject({
      kind: "tool-group",
      id: "tool-group:0:tool:read-1",
      settled: false,
    });
    expect(settledRun[0]).toMatchObject({
      kind: "tool-group",
      id: "tool-group:0:tool:read-1",
      settled: true,
      summary: "Read files",
    });
  });

  it("summarizes a closed mixed-outcome step", () => {
    const parts = [
      part("tool-read_file", {
        toolCallId: "read-1",
        state: "output-available",
      }),
      part("tool-shell", {
        toolCallId: "shell-1",
        state: "output-error",
        errorText: "command failed",
      }),
    ];
    const { workPartIndexes } = splitWorkedForParts(parts);
    const projection = projectAgentWorkParts(parts, workPartIndexes);

    const items = projectAgentWorkTimelineItems({
      activities: projection.activities,
      messageSettled: true,
      parts,
      workPartIndexes,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "tool-group",
      summary: "Read a file, ran a command",
    });
    expect(items[0]?.kind === "tool-group" && items[0].activities).toHaveLength(
      2,
    );
  });

  it.each([
    { exitCode: 1 },
    { failedFiles: [{ path: "missing.txt", reason: "not found" }] },
    { result: { error: "stopped" } },
  ])("groups structural tool failures for output %j", (output) => {
    const parts = [
      part("tool-read_file", {
        toolCallId: "read-1",
        state: "output-available",
      }),
      part("tool-shell", {
        toolCallId: "shell-1",
        state: "output-available",
        output,
      }),
    ];
    const { workPartIndexes } = splitWorkedForParts(parts);
    const projection = projectAgentWorkParts(parts, workPartIndexes);

    expect(
      projectAgentWorkTimelineItems({
        activities: projection.activities,
        messageSettled: true,
        parts,
        workPartIndexes,
      }).map((item) => item.kind),
    ).toEqual(["tool-group"]);
  });

  it("keeps a closed run unsettled while any tool is still in flight", () => {
    const parts = [
      part("tool-read_file", {
        toolCallId: "read-1",
        state: "output-available",
      }),
      part("tool-shell", {
        toolCallId: "shell-1",
        state: "input-available",
      }),
    ];
    const { workPartIndexes } = splitWorkedForParts(parts);
    const projection = projectAgentWorkParts(parts, workPartIndexes);

    expect(
      projectAgentWorkTimelineItems({
        activities: projection.activities,
        messageSettled: true,
        parts,
        workPartIndexes,
      }),
    ).toEqual([
      expect.objectContaining({ kind: "tool-group", settled: false }),
    ]);
  });

  it("uses concise plural summaries for repeated tool categories", () => {
    expect(
      summarizeCompletedToolActivities([
        { id: "one", part: part("tool-read_file"), partIndex: 0 },
        { id: "two", part: part("tool-read_file"), partIndex: 1 },
        { id: "three", part: part("tool-shell"), partIndex: 2 },
      ]),
    ).toBe("Read files, ran a command");
  });

  it("classifies every rendered tool family without the generic fallback", () => {
    const cases = [
      ["tool-shell", {}, "command"],
      ["tool-run_terminal_cmd", {}, "command"],
      ["tool-interact_terminal_session", {}, "command"],
      ["tool-read_file", {}, "read"],
      ["tool-file", { input: { action: "view" } }, "view"],
      ["tool-file", { input: { action: "read" } }, "read"],
      ["tool-file", { input: { action: "write" } }, "edit"],
      ["tool-file", { input: { action: "append" } }, "edit"],
      ["tool-file", { input: { action: "edit" } }, "edit"],
      ["tool-write_file", {}, "edit"],
      ["tool-search_replace", {}, "edit"],
      ["tool-multi_edit", {}, "edit"],
      ["tool-delete_file", {}, "delete"],
      ["tool-get_terminal_files", {}, "download"],
      ["tool-web_search", {}, "search"],
      ["tool-web", {}, "search"],
      ["tool-open_url", {}, "browse"],
      ["tool-http_request", {}, "request"],
      ["tool-send_request", {}, "request"],
      ["tool-todo_write", {}, "tasks"],
      ["tool-create_note", {}, "notes"],
      ["tool-list_notes", {}, "notes"],
      ["tool-update_note", {}, "notes"],
      ["tool-delete_note", {}, "notes"],
      ["tool-list_requests", {}, "proxy"],
      ["tool-view_request", {}, "proxy"],
      ["tool-scope_rules", {}, "proxy"],
      ["tool-list_sitemap", {}, "proxy"],
      ["tool-view_sitemap_entry", {}, "proxy"],
    ] as const;

    for (const [type, extra, expected] of cases) {
      expect(
        getCompletedToolSummaryIconCategory([
          { id: type, part: part(type, extra), partIndex: 0 },
        ]),
      ).toBe(expected);
    }
  });

  it("uses a file-edit icon for file updates and the tool icon for mixed work", () => {
    const editActivities = [
      {
        id: "write",
        part: part("tool-file", { input: { action: "write" } }),
        partIndex: 0,
      },
      {
        id: "edit",
        part: part("tool-file", { input: { action: "edit" } }),
        partIndex: 1,
      },
    ];

    expect(summarizeCompletedToolActivities(editActivities)).toBe(
      "Edited files",
    );
    expect(getCompletedToolSummaryIconCategory(editActivities)).toBe("edit");
    expect(
      getCompletedToolSummaryIconCategory([
        ...editActivities,
        { id: "shell", part: part("tool-shell"), partIndex: 2 },
      ]),
    ).toBe("mixed");
  });

  it("does not merge reasoning across explicit step boundaries", () => {
    const parts = [
      part("step-start"),
      part("reasoning", { text: "first step" }),
      part("step-start"),
      part("reasoning", { text: "second step" }),
    ];
    const { workPartIndexes } = splitWorkedForParts(parts);

    expect(
      projectAgentWorkParts(parts, workPartIndexes).activities,
    ).toHaveLength(2);
  });
});
