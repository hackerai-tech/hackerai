import { observeServiceError } from "../service-error-observation";

const receipt = "[Request ID: 0123456789abcdef] Server Error\n";
const guard = `${receipt}Uncaught Error: Unauthorized: Invalid service request\n    at handler (PRIVATE_STACK)`;
const readLimit = `${receipt}Uncaught Error: Too many bytes read in a single function execution (limit: 16777216 bytes). PRIVATE_HINT\n    at PRIVATE_STACK`;
// The exact output of convexLogger.warn in convex/lib/serviceFunctions.ts.
const producer = (label: string, extra = "") =>
  `{"level":"warn","event":"service_proof_rejected","timestamp":"2026-11-16T16:04:34.714Z","diagnostic_version":1,"public_input_observation":"${label}"${extra}}`;
// The caller-visible rendering verified on Preview.
const warnLine = (label: string, extra = "") =>
  `[WARN] '${producer(label, extra)}'`;
const unrelated = [
  "[LOG] 'PRIVATE_LOG service_proof_rejected proof_expired'",
  `[WARN] '{"level":"warn","event":"other","detail":"PRIVATE_LOG"}'`,
  `[WARN] 'PRIVATE ${producer("proof_expired")}'`,
];

it.each([
  [
    "a producer line among unrelated lines",
    [...unrelated, warnLine("proof_expired")],
    { status: "recognized", label: "proof_expired", lines: 1 },
  ],
  [
    "propagated lines with one label",
    [warnLine("verification_failed"), warnLine("verification_failed")],
    { status: "recognized", label: "verification_failed", lines: 2 },
  ],
  [
    "propagated lines with different labels",
    [warnLine("proof_future"), warnLine("proof_malformed")],
    { status: "ambiguous", lines: 2 },
  ],
  [
    "a recognized line beside an unsupported one",
    [warnLine("proof_expired"), warnLine("proof_expired", ',"x":"PRIVATE"')],
    { status: "ambiguous", lines: 1 },
  ],
  ["no log receipt", undefined, { status: "unavailable" }],
  ["a non-array log receipt", "PRIVATE_LOG", { status: "unavailable" }],
  ["an empty receipt", [], { status: "not_found", lines: 0 }],
  ["only unrelated lines", unrelated, { status: "not_found", lines: 0 }],
  [
    "an unproven unquoted rendering",
    [`[WARN] ${producer("proof_expired")}`],
    { status: "unsupported", lines: 0 },
  ],
  [
    "an unknown label",
    [warnLine("PRIVATE_LABEL")],
    { status: "unsupported", lines: 0 },
  ],
  [
    "another diagnostic version",
    [warnLine("proof_expired").replace('_version":1', '_version":2')],
    { status: "unsupported", lines: 0 },
  ],
  [
    "an extra private field",
    [warnLine("proof_expired", ',"detail":"PRIVATE"')],
    { status: "unsupported", lines: 0 },
  ],
  [
    "an oversized producer line",
    [warnLine("proof_expired", `,"pad":"${"PRIVATE".repeat(50)}"`)],
    { status: "unsupported", lines: 0 },
  ],
  [
    "a non-string line",
    [{ level: "WARN", messages: ["PRIVATE_LOG"] }],
    { status: "unsupported", lines: 0 },
  ],
  [
    "a receipt beyond known SDK bounds",
    [...Array(301).fill("[LOG] 'x'"), warnLine("proof_expired")],
    { status: "unsupported" },
  ],
])(
  "reports a guard rejection with %s without defaulting to a label",
  (_name, logLines, expected) => {
    const observed = observeServiceError({ errorMessage: guard, logLines });
    expect(observed).toEqual({
      service_error_diagnostic_version: 1,
      public_backend_error_kind: "invalid_service_request",
      service_proof_log_lines: expected.status,
      // Distinguishes an empty receipt from lines this reader cannot interpret.
      ...(Array.isArray(logLines) ? { log_line_count: logLines.length } : {}),
      ...("lines" in expected
        ? { service_proof_rejection_lines: expected.lines }
        : {}),
      ...("label" in expected
        ? { public_input_observation: expected.label }
        : {}),
    });
    expect(JSON.stringify(observed)).not.toContain("PRIVATE");
  },
);

it.each([
  [
    "a bare guard line",
    `${receipt}Uncaught Error: Unauthorized: Invalid service request`,
    "invalid_service_request",
  ],
  ["a read-limit line with its limit", readLimit, "read_byte_limit"],
  [
    "a bare read-limit line",
    `${receipt}Uncaught Error: Too many bytes read in a single function execution`,
    "read_byte_limit",
  ],
])("classifies %s and keeps no message text", (_name, errorMessage, kind) => {
  const observed = observeServiceError({
    errorMessage,
    logLines: [warnLine("proof_expired")],
  });
  expect(observed?.public_backend_error_kind).toBe(kind);
  // The read limit never reads proof lines or copies counts and hints.
  if (kind === "read_byte_limit")
    expect(observed).toEqual({
      service_error_diagnostic_version: 1,
      public_backend_error_kind: kind,
    });
  expect(JSON.stringify(observed)).not.toMatch(/PRIVATE|16777216/);
});

it.each([
  ["a redacted native receipt", "[Request ID: 0123456789abcdef] Server Error"],
  ["a private payload", `${receipt}Uncaught Error: PRIVATE_MESSAGE`],
  [
    "a marker inside other text",
    `${receipt}Uncaught Error: PRIVATE Unauthorized: Invalid service request`,
  ],
  ["a longer guard-like line", guard.replace("request\n", "requests\n")],
  ["a longer read-like line", readLimit.replace("execution (", "executions (")],
  [
    "a marker on a later line",
    `${receipt}Uncaught Error: PRIVATE\nUncaught Error: Unauthorized: Invalid service request`,
  ],
])(
  "keeps %s unclassified but reads its proof receipt",
  (_name, errorMessage) => {
    // The label describes the received line, not this unknown error's cause.
    expect(
      observeServiceError({
        errorMessage,
        logLines: [warnLine("proof_expired")],
      }),
    ).toEqual({
      service_error_diagnostic_version: 1,
      public_backend_error_kind: "unclassified",
      service_proof_log_lines: "recognized",
      log_line_count: 1,
      service_proof_rejection_lines: 1,
      public_input_observation: "proof_expired",
    });
  },
);

it.each([
  [
    "no native receipt",
    "PRIVATE_MESSAGE Unauthorized: Invalid service request",
  ],
  ["a receipt after other text", ` ${guard}`],
  ["a receipt without its line end", `${receipt.trim()} PRIVATE`],
  ["a receipt without Server Error", guard.slice(0, 31) + "PRIVATE"],
  [
    "an invalid request receipt",
    guard.replace("0123456789abcdef", "PRIVATE_LABEL_01"),
  ],
  ["a non-string message", { message: guard }],
])("ignores %s", (_name, errorMessage) => {
  expect(
    observeServiceError({
      errorMessage,
      logLines: [warnLine("proof_expired")],
    }),
  ).toBeUndefined();
});

it("ignores a typed ConvexError carrying a native receipt", () => {
  expect(
    observeServiceError({ errorMessage: guard, errorData: { reason: "x" } }),
  ).toBeUndefined();
});
