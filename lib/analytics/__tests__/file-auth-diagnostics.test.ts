import { describe, expect, it, jest } from "@jest/globals";
import {
  classifyFileActionAuthFailure,
  FILE_ACTION_AUTH_DIAGNOSTIC_EVENT,
  projectFileActionAuthDiagnostic,
  readClosedConvexClientAuthState,
  sanitizeFileActionAuthDiagnosticEvent,
} from "../file-auth-diagnostics";

const REQUEST_ID = "0123456789abcdef";
const prefix = (fn: string, id = REQUEST_ID) =>
  `[CONVEX A(s3Actions:${fn})] [Request ID: ${id}] Server Error`;
const redacted = (fn: string, id?: string) =>
  `${prefix(fn, id)}\n  Called by client`;
const guard = (fn: string, verb: "access" | "upload") =>
  `${prefix(fn)}\nUncaught Error: Unauthenticated: User must be logged in to ${verb} files\n    at handler (../convex/s3Actions.ts:290:10)\n\n  Called by client`;

describe("classifyFileActionAuthFailure", () => {
  it.each([
    [
      "a redacted production failure",
      new Error(redacted("getFileUrlAction")),
      "getFileUrlAction",
      "redacted_server_error",
    ],
    [
      "a redacted failure without the client suffix",
      new Error(prefix("getFileUrlAction")),
      "getFileUrlAction",
      "redacted_server_error",
    ],
    [
      "the URL guard's own message",
      new Error(guard("getFileUrlAction", "access")),
      "getFileUrlAction",
      "unauthenticated_message",
    ],
    [
      "the upload guard's own message",
      new Error(guard("generateS3UploadUrlAction", "upload")),
      "generateS3UploadUrlAction",
      "unauthenticated_message",
    ],
    [
      "a frozen redacted failure",
      Object.freeze(new Error(redacted("generateS3UploadUrlAction"))),
      "generateS3UploadUrlAction",
      "redacted_server_error",
    ],
  ] as const)(
    "recognizes %s with its request ID",
    (_name, error, operation, failureClass) => {
      expect(classifyFileActionAuthFailure(error, operation)).toEqual({
        failure_class: failureClass,
        convex_request_id: REQUEST_ID,
      });
    },
  );

  const convexError = Object.assign(new Error(redacted("getFileUrlAction")), {
    data: { code: "PAID_PLAN_REQUIRED" },
  });
  it.each<[string, unknown, "getFileUrlAction" | "generateS3UploadUrlAction"]>([
    // No auth false positives from visible, application or transport errors.
    [
      "a visible non-auth server error",
      new Error(
        `${prefix("getFileUrlAction")}\nUncaught Error: Failed to get file URL\n\n  Called by client`,
      ),
      "getFileUrlAction",
    ],
    [
      "an upload validation error",
      new Error(
        `${prefix("generateS3UploadUrlAction")}\nUncaught Error: Invalid fileName: fileName cannot be empty`,
      ),
      "generateS3UploadUrlAction",
    ],
    [
      "a guard-like prefix of a longer message",
      new Error(
        `${prefix("getFileUrlAction")}\nUncaught Error: Unauthenticated: User must be logged in to access filesystem`,
      ),
      "getFileUrlAction",
    ],
    [
      "the other operation's guard message",
      new Error(
        `${prefix("generateS3UploadUrlAction")}\nUncaught Error: Unauthenticated: User must be logged in to access files`,
      ),
      "generateS3UploadUrlAction",
    ],
    ["a ConvexError application outcome", convexError, "getFileUrlAction"],
    [
      "a different function",
      new Error(redacted("getFileUrlsBatchAction")),
      "getFileUrlAction",
    ],
    [
      "the other evidenced function",
      new Error(redacted("generateS3UploadUrlAction")),
      "getFileUrlAction",
    ],
    [
      "a query prefix",
      new Error(redacted("getFileUrlAction").replace("CONVEX A(", "CONVEX Q(")),
      "getFileUrlAction",
    ],
    [
      "an unanchored prefix",
      new Error(`PRIVATE ${redacted("getFileUrlAction")}`),
      "getFileUrlAction",
    ],
    [
      "an uppercase request ID",
      new Error(redacted("getFileUrlAction", "0123456789ABCDEF")),
      "getFileUrlAction",
    ],
    [
      "a short request ID",
      new Error(redacted("getFileUrlAction", "0123456789abcde")),
      "getFileUrlAction",
    ],
    [
      "an oversized message",
      new Error(`${prefix("getFileUrlAction")}${" ".repeat(4096)}`),
      "getFileUrlAction",
    ],
    ["a bare string", redacted("getFileUrlAction"), "getFileUrlAction"],
    ["a transport failure", new Error("Connection lost"), "getFileUrlAction"],
    ["no error", undefined, "getFileUrlAction"],
  ])("ignores %s", (_name, error, operation) => {
    expect(classifyFileActionAuthFailure(error, operation)).toBeNull();
  });

  it("never runs a message getter or a throwing proxy trap", () => {
    const getter = jest.fn(() => redacted("getFileUrlAction"));
    const accessor = Object.defineProperty(new Error(), "message", {
      get: getter,
    });
    expect(
      classifyFileActionAuthFailure(accessor, "getFileUrlAction"),
    ).toBeNull();
    expect(getter).not.toHaveBeenCalled();

    const trap = new Proxy(new Error(redacted("getFileUrlAction")), {
      getOwnPropertyDescriptor: () => {
        throw new Error("PRIVATE_TRAP");
      },
    });
    expect(classifyFileActionAuthFailure(trap, "getFileUrlAction")).toBeNull();
  });
});

describe("readClosedConvexClientAuthState", () => {
  it.each([
    [{ isLoading: true, isAuthenticated: false }, "loading"],
    [{ isLoading: true, isAuthenticated: true }, "loading"],
    [{ isLoading: false, isAuthenticated: true }, "authenticated"],
    [{ isLoading: false, isAuthenticated: false }, "unauthenticated"],
    [{ isLoading: "false", isAuthenticated: true }, "unavailable"],
    [{ isAuthenticated: true }, "unavailable"],
    [null, "unavailable"],
  ])("closes %p as %s", (value, state) => {
    expect(readClosedConvexClientAuthState(() => value)).toBe(state);
  });

  it("is unavailable for getters and throwing reads", () => {
    const getter = jest.fn(() => false);
    expect(
      readClosedConvexClientAuthState(() =>
        Object.defineProperty({ isAuthenticated: true }, "isLoading", {
          get: getter,
        }),
      ),
    ).toBe("unavailable");
    expect(getter).not.toHaveBeenCalled();
    expect(
      readClosedConvexClientAuthState(() => {
        throw new Error("no provider");
      }),
    ).toBe("unavailable");
  });
});

const diagnostic = {
  file_action_auth_diagnostic_version: 1,
  caller: "inline_image",
  operation: "getFileUrlAction",
  failure_class: "redacted_server_error",
  convex_request_id: REQUEST_ID,
  request_convex_auth_state: "loading",
  convex_auth_state: "authenticated",
  request_provider_state: "authkit_loading",
  provider_state: "ready",
  request_token_mode: "ordinary",
  request_token_outcome: "pending",
  request_token_result: "pending",
  request_token_age: "lt_1s",
  request_token_context: "same",
  token_mode: "ordinary",
  token_outcome: "token",
  token_result: "token",
  token_age: "lt_1s",
  token_context: "same",
  token_attempt: "same",
  input_relation: "first",
  observer_scope_id: "0193a5b2-7c41-7a10-8f00-1234567890ab",
  hackerai_frontend_build_commit: "a".repeat(40),
};
const project = (properties: Record<string, unknown>) =>
  projectFileActionAuthDiagnostic((key) => properties[key]);

describe("projectFileActionAuthDiagnostic", () => {
  it("rebuilds only the closed schema", () => {
    expect(project({ ...diagnostic, private_field: "PRIVATE" })).toEqual(
      diagnostic,
    );
  });

  it("accepts optional fields as absent and wholly unavailable token context", () => {
    const {
      convex_request_id: _id,
      observer_scope_id: _scope,
      hackerai_frontend_build_commit: _build,
      ...required
    } = diagnostic;
    const unavailable = {
      ...required,
      caller: "upload",
      operation: "generateS3UploadUrlAction",
      input_relation: "unavailable",
      provider_state: "unavailable",
      token_attempt: "unavailable",
      token_mode: "unavailable",
      token_outcome: "unavailable",
      token_result: "unavailable",
      token_age: "unavailable",
      token_context: "unavailable",
    };
    expect(project(unavailable)).toEqual(unavailable);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a string version", { file_action_auth_diagnostic_version: "1" }],
    ["a later version", { file_action_auth_diagnostic_version: 2 }],
    ["an unknown caller", { caller: "all_files_dialog" }],
    ["a prototype caller", { caller: "toString" }],
    ["a mismatched operation", { operation: "generateS3UploadUrlAction" }],
    ["an unknown operation", { operation: "getFileUrlsBatchAction" }],
    ["an unknown failure class", { failure_class: "unauthorized" }],
    ["a malformed request ID", { convex_request_id: "PRIVATE_REQUEST_01" }],
    ["an unknown Convex auth state", { convex_auth_state: "ready" }],
    ["an unknown provider state", { request_provider_state: "signed_in" }],
    ["a partly unavailable token", { token_age: "unavailable" }],
    ["an unknown token outcome", { request_token_outcome: "jwt" }],
    ["an unknown attempt relation", { token_attempt: "maybe" }],
    ["an unknown input relation", { input_relation: "PRIVATE_FILE_ID" }],
    [
      "an upload input comparison",
      {
        caller: "upload",
        operation: "generateS3UploadUrlAction",
        input_relation: "same",
      },
    ],
    ["a non-UUID scope", { observer_scope_id: "PRIVATE_SCOPE" }],
    ["an uppercase build", { hackerai_frontend_build_commit: "A".repeat(40) }],
    ["a missing field", { convex_auth_state: undefined }],
  ])("rejects %s", (_name, override) => {
    expect(project({ ...diagnostic, ...override })).toBeNull();
  });
});

describe("sanitizeFileActionAuthDiagnosticEvent", () => {
  const owner = "user_01ABC";
  const expected = () => ({ owner, token: "phc_test" });
  const eventUuid = "0193a5b2-7c41-7a10-8f00-aaaaaaaaaaaa";
  const transport = {
    token: "phc_test",
    distinct_id: owner,
    $session_id: "0193a5b2-7c41-7a10-8f00-bbbbbbbbbbbb",
    $lib: "web",
    $lib_version: "1.447.5",
    $is_identified: true,
  };
  const enriched = (properties: Record<string, unknown>) => ({
    uuid: eventUuid,
    event: FILE_ACTION_AUTH_DIAGNOSTIC_EVENT,
    properties: {
      ...properties,
      $current_url: "https://hackerai.co/c/PRIVATE_CHAT",
      $set: { email: "PRIVATE_EMAIL" },
      fileId: "PRIVATE_FILE_ID",
      url: "https://bucket.s3.test/PRIVATE_KEY?X-Amz-Signature=PRIVATE",
      error: "PRIVATE_ERROR_MESSAGE",
      access_token: "PRIVATE_TOKEN",
    },
    timestamp: new Date(1_794_094_000_000),
    $set_once: { $initial_referrer: "PRIVATE" },
  });

  it("rebuilds the owner's event from validated fields only", () => {
    const sanitized = sanitizeFileActionAuthDiagnosticEvent(
      enriched({ ...transport, ...diagnostic }),
      expected,
    );
    expect(sanitized).toEqual({
      uuid: eventUuid,
      event: FILE_ACTION_AUTH_DIAGNOSTIC_EVENT,
      properties: { ...transport, ...diagnostic },
      timestamp: new Date(1_794_094_000_000),
    });
    expect(JSON.stringify(sanitized)).not.toContain("PRIVATE");
  });

  it("drops a schema field accessor without running it", () => {
    const getter = jest.fn(() => "inline_image");
    const properties = Object.defineProperty(
      { ...transport, ...diagnostic },
      "caller",
      { get: getter, enumerable: true },
    );
    expect(
      sanitizeFileActionAuthDiagnosticEvent(
        { event: FILE_ACTION_AUTH_DIAGNOSTIC_EVENT, properties },
        expected,
      ),
    ).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each<[string, () => { owner: string | null; token: string }]>([
    ["no committed owner", () => ({ owner: null, token: "phc_test" })],
    ["a different owner", () => ({ owner: "user_other", token: "phc_test" })],
    ["a malformed owner", () => ({ owner: "a@b.test", token: "phc_test" })],
    [
      "a failing owner read",
      () => {
        throw new Error("identity unavailable");
      },
    ],
  ])("drops the event for %s", (_name, resolve) => {
    expect(
      sanitizeFileActionAuthDiagnosticEvent(
        enriched({ ...transport, ...diagnostic }),
        resolve,
      ),
    ).toBeNull();
  });

  it("drops malformed targets and leaves other events untouched", () => {
    expect(
      sanitizeFileActionAuthDiagnosticEvent(
        enriched({ ...transport, ...diagnostic, caller: "upload" }),
        expected,
      ),
    ).toBeNull();
    expect(
      sanitizeFileActionAuthDiagnosticEvent(
        { event: FILE_ACTION_AUTH_DIAGNOSTIC_EVENT, properties: [] },
        expected,
      ),
    ).toBeNull();
    expect(
      sanitizeFileActionAuthDiagnosticEvent(
        Object.defineProperty({}, "event", {
          get: () => FILE_ACTION_AUTH_DIAGNOSTIC_EVENT,
        }),
        expected,
      ),
    ).toBeNull();

    const resolve = jest.fn(expected);
    const other = { event: "$exception", properties: { fileId: "kept" } };
    expect(sanitizeFileActionAuthDiagnosticEvent(other, resolve)).toBe(other);
    expect(resolve).not.toHaveBeenCalled();
  });
});
