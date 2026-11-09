jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));

import { phLogger } from "@/lib/posthog/server";
import { captureAgentBrowserOpenFailure } from "../utils/agent-browser-open-failure";

const event = phLogger.event as jest.Mock;
const base = {
  context: {
    userID: "opaque-user",
    chatId: "opaque-chat",
    triggerRunId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  command: "agent-browser open https://private.example/secret",
  isBackground: false,
  aborted: false,
  result: { processStarted: true, exitCode: 1, output: "" } as Record<
    string,
    unknown
  >,
};
beforeEach(() => event.mockReset());

test.each([
  ["\x1b[31m✗ Daemon failed to start (/private/socket)\x1b[0m", "daemon_start"],
  ["Failed to start daemon: private detail", "daemon_start"],
  ["Failed to connect: private socket", "daemon_transport"],
  ["Chrome launch task failed: private details", "browser_launch"],
  [
    "Navigation failed: net::ERR_NAME_NOT_RESOLVED https://private.example",
    "navigation",
  ],
  ["page.goto: net::ERR_CONNECTION_REFUSED at private URL", "navigation"],
  [
    "Navigation failed: private\nDaemon failed to start (private)",
    "multiple_markers",
  ],
  ["PRIVATE_UNKNOWN_EXCEPTION and navigation discussion", "no_known_marker"],
])(
  "exports a closed marker without its private suffix (%s)",
  (output, hint) => {
    captureAgentBrowserOpenFailure({
      ...base,
      result: { ...base.result, output },
    });
    expect(event).toHaveBeenCalledTimes(1);
    const fields = event.mock.calls[0][1];
    expect(fields.public_output_hint).toBe(hint);
    expect(Object.keys(fields).sort()).toEqual(
      [
        "userId",
        "chat_id",
        "browser_open_failure_version",
        "observation_scope",
        "public_output_hint",
        "public_json_error_state",
        "json_candidate_limit_reached",
        "output_sample_present",
        "output_sample_truncated",
        "detected_invocation_count",
        "exit_code",
        "owner_run_status",
        "owner_trigger_run_id",
      ].sort(),
    );
    expect(JSON.stringify(fields)).not.toMatch(/private|PRIVATE|socket/);
  },
);

test.each([
  { result: { ...base.result, exitCode: 0 } },
  { result: { ...base.result, exitCode: null } },
  { result: { ...base.result, exitCode: NaN } },
  { result: { ...base.result, exitCode: -1 } },
  { result: { ...base.result, processStarted: undefined } },
  { result: { ...base.result, executionOutcome: "unknown" } },
  { result: { ...base.result, timedOut: true } },
  { result: { ...base.result, approvalDenied: true } },
  { interactive: true },
  { isBackground: true },
  { aborted: true },
  { command: "agent-browser snapshot -i" },
  { command: "echo 'agent-browser open private'" },
])(
  "does not turn unqualified terminal results into browser failures (%j)",
  (override) => {
    captureAgentBrowserOpenFailure({ ...base, ...override });
    expect(event).not.toHaveBeenCalled();
  },
);

test("scans bounded head/tail, reports skipped middle and keeps error field eligible", () => {
  captureAgentBrowserOpenFailure({
    ...base,
    result: {
      ...base.result,
      output:
        "x".repeat(5000) + "\nDaemon failed to start\n" + "x".repeat(5000),
      error: "x".repeat(5000) + "\nNavigation failed: PRIVATE_URL",
    },
  });
  expect(event.mock.calls[0][1]).toMatchObject({
    public_output_hint: "navigation",
    output_sample_truncated: true,
  });
});

test("marks unknown owners and compound intent honestly and isolates diagnostic failures", () => {
  const args = {
    ...base,
    context: { ...base.context, triggerRunId: "PRIVATE_OWNER" },
    command: `${base.command}; false`,
  };
  captureAgentBrowserOpenFailure(args);
  expect(event.mock.calls[0][1]).toMatchObject({
    owner_run_status: "unavailable",
    observation_scope: "terminal_result_open_intent",
  });
  expect(event.mock.calls[0][1]).not.toHaveProperty("owner_trigger_run_id");
  event.mockImplementation(() => {
    throw new Error("logging unavailable");
  });
  expect(() => captureAgentBrowserOpenFailure(args)).not.toThrow();
  expect(args.result).toEqual(base.result);
});

// Actual21 OPENexit1 source usage was option-prefixed; do not infer its action.
test("retains public hints for option-prefixed browser intent without asserting OPEN", () => {
  captureAgentBrowserOpenFailure({
    ...base,
    command: "agent-browser --session PRIVATE_SESSION open PRIVATE_URL",
    result: {
      ...base.result,
      output: "Daemon failed to start (PRIVATE_SOCKET)",
    },
  });
  expect(event).toHaveBeenCalledWith(
    "agent_browser_terminal_open_failure",
    expect.objectContaining({
      browser_open_failure_version: 3,
      observation_scope: "terminal_result_option_intent",
      public_output_hint: "daemon_start",
    }),
  );
  expect(JSON.stringify(event.mock.calls)).not.toContain("PRIVATE");
});

test("recognizes a supported CLI JSON error without exporting its contents", () => {
  captureAgentBrowserOpenFailure({
    ...base,
    command: "agent-browser --json open https://private.example/secret",
    result: {
      ...base.result,
      output: JSON.stringify({
        success: false,
        error: "Navigation failed: PRIVATE_URL",
        data: { private: "PRIVATE_DATA" },
      }),
    },
  });
  expect(event.mock.calls[0][1]).toMatchObject({
    browser_open_failure_version: 3,
    public_output_hint: "navigation",
    public_json_error_state: "observed",
    json_candidate_limit_reached: false,
  });
  expect(JSON.stringify(event.mock.calls)).not.toMatch(
    /PRIVATE|private.example/,
  );
});

test.each([
  [{ success: true, error: "Navigation failed: PRIVATE" }, "not_observed"],
  [
    { data: { success: false, error: "Navigation failed: PRIVATE" } },
    "not_observed",
  ],
  [[{ success: false, error: "Navigation failed: PRIVATE" }], "not_observed"],
  [
    { success: false, error: { message: "Navigation failed: PRIVATE" } },
    "not_observed",
  ],
])(
  "does not traverse data or classify successful/nonstandard JSON (%#)",
  (response, state) => {
    captureAgentBrowserOpenFailure({
      ...base,
      result: { ...base.result, output: JSON.stringify(response) },
    });
    expect(event.mock.calls[0][1]).toMatchObject({
      public_output_hint: "no_known_marker",
      public_json_error_state: state,
    });
  },
);

test("caps JSON candidates across output and error, retaining observed markers honestly", () => {
  const benign = JSON.stringify({ success: true });
  const hidden = JSON.stringify({
    success: false,
    error: "Navigation failed: PRIVATE",
  });
  captureAgentBrowserOpenFailure({
    ...base,
    result: {
      ...base.result,
      output: Array(8).fill(benign).join("\n"),
      error: hidden,
    },
  });
  expect(event.mock.calls[0][1]).toMatchObject({
    public_output_hint: "no_known_marker",
    public_json_error_state: "incomplete",
    json_candidate_limit_reached: true,
  });
  event.mockClear();
  captureAgentBrowserOpenFailure({
    ...base,
    result: {
      ...base.result,
      output: hidden + "\n" + Array(8).fill(benign).join("\n"),
    },
  });
  expect(event.mock.calls[0][1]).toMatchObject({
    public_output_hint: "navigation",
    public_json_error_state: "observed",
    json_candidate_limit_reached: true,
  });
});

test("combines text and decoded markers and reports incomplete JSON without exporting it", () => {
  captureAgentBrowserOpenFailure({
    ...base,
    result: {
      ...base.result,
      output:
        "Failed to read: PRIVATE\n" +
        JSON.stringify({
          success: false,
          error: "\u001b[31m✗ Navigation failed: PRIVATE\u001b[0m",
        }),
      error: "{PRIVATE_INCOMPLETE",
    },
  });
  expect(event.mock.calls[0][1]).toMatchObject({
    public_output_hint: "multiple_markers",
    public_json_error_state: "observed",
  });
  expect(JSON.stringify(event.mock.calls)).not.toContain("PRIVATE");
  event.mockClear();
  captureAgentBrowserOpenFailure({
    ...base,
    result: {
      ...base.result,
      output: '{"success":false,"error":"' + "PRIVATE".repeat(1500),
    },
  });
  expect(event.mock.calls[0][1]).toMatchObject({
    public_output_hint: "no_known_marker",
    public_json_error_state: "incomplete",
    output_sample_truncated: true,
  });
});
