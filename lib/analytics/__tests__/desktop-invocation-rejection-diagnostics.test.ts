import {
  classifyNativeInvocationRejection,
  classifyNativeInvocationRejectionMessage,
  desktopInvocationAdmissionDiagnostic,
  desktopInvocationRejectionDiagnostic,
  readDesktopInvocationAdmissionDiagnostic,
  readDesktopInvocationRejectionDiagnostic,
} from "../desktop-invocation-rejection-diagnostics";

const unclassified = { reason: "unknown", admission: null };

describe("classifyNativeInvocationRejection", () => {
  // The native apps' fixed rejection messages and their message classes.
  it.each<[string, string, string | null]>([
    [
      "Invalid Desktop operation authorization",
      "authorization_id_invalid",
      null,
    ],
    ["Invalid Desktop operation", "authorization_precondition", null],
    ["Desktop origin is unavailable", "authorization_precondition", null],
    [
      "Desktop origin is not allowed for native authorization",
      "authorization_precondition",
      null,
    ],
    [
      "Desktop authorization client unavailable",
      "authorization_precondition",
      null,
    ],
    [
      "Desktop operation authorization unavailable",
      "authorization_unavailable",
      null,
    ],
    [
      "Desktop operation was not authorized",
      "authorization_not_approved",
      null,
    ],
    [
      "Invalid Desktop authorization response",
      "authorization_response_invalid",
      null,
    ],
    ["Desktop operation type is missing", "operation_rejected", null],
    ["Desktop operation type is not allowed here", "operation_rejected", null],
    ["Invalid authorized command", "operation_rejected", null],
    // update_safety.rs, command_stdin.rs and lib.rs, verbatim.
    [
      "Desktop update state unavailable",
      "execution_admission",
      "update_state_unavailable",
    ],
    [
      "Desktop is installing an update. Reopen the app before retrying.",
      "execution_admission",
      "update_installing",
    ],
    ["Command stdin exceeds limit", "execution_admission", "stdin_size_limit"],
    [
      "Invalid command stdin encoding",
      "execution_admission",
      "stdin_encoding_invalid",
    ],
    [
      "stream command state lock poisoned",
      "execution_admission",
      "command_state_lock_poisoned",
    ],
    [
      "Command is already running",
      "execution_admission",
      "command_already_running",
    ],
    ["Failed to spawn: PRIVATE (os error 2)", "spawn_failed", null],
    ["Failed to spawn: ", "spawn_failed", null],
  ])("classifies %p as %s and %s", (message, reason, admission) => {
    expect(classifyNativeInvocationRejection(message)).toBe(reason);
    expect(classifyNativeInvocationRejectionMessage(message)).toEqual({
      reason,
      admission,
    });
    // A real Error's own message is read the same way.
    expect(classifyNativeInvocationRejection(new Error(message))).toBe(reason);
    expect(
      classifyNativeInvocationRejectionMessage(new Error(message)),
    ).toEqual({ reason, admission });
  });

  it.each<[string, unknown]>([
    ["a trailing space", "Desktop operation was not authorized "],
    ["a leading space", " Desktop operation was not authorized"],
    ["a trailing newline", "Invalid Desktop operation authorization\n"],
    ["a case change", "desktop operation was not authorized"],
    ["a truncated message", "Desktop operation was not"],
    ["an appended suffix", "Invalid Desktop operation PRIVATE"],
    ["a spawn message without its separator", "Failed to spawn PRIVATE"],
    ["a lower-case spawn message", "failed to spawn: PRIVATE"],
    ["an embedded spawn message", "PRIVATE Failed to spawn: x"],
    ["an over-long spawn message", `Failed to spawn: ${"PRIVATE".repeat(200)}`],
    // Tauri runtime and stream-event messages are not rejection classes here.
    [
      "a Tauri ACL message",
      "Command execute_authorized_stream_command not allowed by ACL",
    ],
    ["a Tauri missing command", "Command execute_stream_command not found"],
    ["a native timeout event", "Command timed out after 30000ms"],
    ["a native process event", "Process error: PRIVATE"],
    ["an empty message", ""],
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    [
      "a plain object with a known message",
      { message: "Desktop operation was not authorized" },
    ],
    [
      "an object that stringifies to a known message",
      { toString: () => "Desktop operation was not authorized" },
    ],
    // Changed admission templates never fall back to a nearby class.
    ["a punctuated admission message", "Command is already running."],
    ["a sized stdin message", "Command stdin exceeds limit: 4096"],
    ["a truncated update message", "Desktop is installing an update."],
    ["a lower-case admission message", "command is already running"],
    [
      "an over-long admission message",
      `Command is already running${" ".repeat(1024)}`,
    ],
    [
      "a plain object with an admission message",
      { message: "Invalid command stdin encoding" },
    ],
    [
      "an object that stringifies to an admission message",
      { toString: () => "Command stdin exceeds limit" },
    ],
    [
      "an Error inheriting an admission message",
      (() => {
        class InheritedError extends Error {}
        InheritedError.prototype.message = "Command is already running";
        return new InheritedError();
      })(),
    ],
  ])("classifies %s as unknown", (_case, error) => {
    expect(classifyNativeInvocationRejection(error)).toBe("unknown");
    expect(classifyNativeInvocationRejectionMessage(error)).toEqual(
      unclassified,
    );
  });

  it("never runs a message getter, toString or a throwing proxy trap", () => {
    let reads = 0;
    class GetterError extends Error {}
    Object.defineProperty(GetterError.prototype, "message", {
      get() {
        reads++;
        return "Desktop operation was not authorized";
      },
    });
    const stringified = new Error("Command is already running");
    Object.defineProperty(stringified, "message", {
      get() {
        reads++;
        return "Command is already running";
      },
    });
    stringified.toString = () => {
      reads++;
      return "Command is already running";
    };
    const fail = () => {
      throw new Error("PRIVATE");
    };
    for (const error of [
      new GetterError(),
      stringified,
      new Proxy(new Error("Command is already running"), {
        get: fail,
        getOwnPropertyDescriptor: fail,
        getPrototypeOf: fail,
      }),
      // A proxy failing only its descriptor read is still nothing.
      new Proxy(new Error("Command stdin exceeds limit"), {
        get: fail,
        getOwnPropertyDescriptor: fail,
      }),
    ]) {
      expect(classifyNativeInvocationRejection(error)).toBe("unknown");
      expect(classifyNativeInvocationRejectionMessage(error)).toEqual(
        unclassified,
      );
    }
    expect(reads).toBe(0);
  });
});

describe("desktopInvocationAdmissionDiagnostic", () => {
  const admissionReasons = [
    "update_state_unavailable",
    "update_installing",
    "stdin_size_limit",
    "stdin_encoding_invalid",
    "command_state_lock_poisoned",
    "command_already_running",
  ];

  it.each(admissionReasons)(
    "refines execution_admission from every native command set with %s",
    (admission) => {
      for (const adapter of [
        "authorized_native",
        "compatibility_native",
        "published_legacy_native",
      ]) {
        const group = desktopInvocationAdmissionDiagnostic(
          desktopInvocationRejectionDiagnostic("execution_admission", adapter),
          admission,
        );
        expect(group).toEqual({
          desktop_invocation_admission_version: 1,
          desktop_invocation_admission_reason: admission,
        });
        expect(Object.isFrozen(group)).toBe(true);
      }
    },
  );

  it("never refines another class, or no class", () => {
    for (const [reason, adapter] of [
      ["spawn_failed", "authorized_native"],
      ["unknown", "authorized_native"],
      ["unknown", "not_selected"],
      ["authorization_unavailable", "authorized_native"],
    ])
      expect(
        desktopInvocationAdmissionDiagnostic(
          desktopInvocationRejectionDiagnostic(reason, adapter),
          "command_already_running",
        ),
      ).toBeNull();
    expect(
      desktopInvocationAdmissionDiagnostic(null, "command_already_running"),
    ).toBeNull();
  });

  it.each<[string, unknown]>([
    ["no admission class", null],
    ["an undefined admission class", undefined],
    ["an unlisted admission class", "unknown"],
    ["a raw native message", "Command is already running"],
    ["a private value", "PRIVATE"],
    ["a number", 1],
  ])("builds nothing for %s", (_case, admission) => {
    expect(
      desktopInvocationAdmissionDiagnostic(
        desktopInvocationRejectionDiagnostic(
          "execution_admission",
          "authorized_native",
        ),
        admission,
      ),
    ).toBeNull();
  });
});

describe("readDesktopInvocationAdmissionDiagnostic", () => {
  const rejection = desktopInvocationRejectionDiagnostic(
    "execution_admission",
    "authorized_native",
  );
  const group = {
    desktop_invocation_admission_version: 1,
    desktop_invocation_admission_reason: "stdin_encoding_invalid",
  };

  it("copies only the complete group's data values", () => {
    const read = readDesktopInvocationAdmissionDiagnostic(
      { ...group, stdin: "PRIVATE", message: "PRIVATE" },
      rejection,
    );
    expect(read).toEqual(group);
    expect(Object.isFrozen(read)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["no source", undefined],
    ["a string source", "PRIVATE"],
    ["an empty bag", {}],
    [
      "a missing reason",
      { ...group, desktop_invocation_admission_reason: undefined },
    ],
    [
      "a missing version",
      { ...group, desktop_invocation_admission_version: undefined },
    ],
    [
      "an unsupported version",
      { ...group, desktop_invocation_admission_version: 2 },
    ],
    [
      "a string version",
      { ...group, desktop_invocation_admission_version: "1" },
    ],
    [
      "a raw native message as reason",
      {
        ...group,
        desktop_invocation_admission_reason: "Invalid command stdin encoding",
      },
    ],
    [
      "an inherited group",
      Object.create(group as object) as Record<string, unknown>,
    ],
  ])("reads nothing for %s", (_case, source) => {
    expect(
      readDesktopInvocationAdmissionDiagnostic(source, rejection),
    ).toBeNull();
  });

  it("reads nothing without a validated execution_admission class", () => {
    for (const other of [
      null,
      desktopInvocationRejectionDiagnostic("spawn_failed", "authorized_native"),
      desktopInvocationRejectionDiagnostic("unknown", "not_selected"),
    ])
      expect(
        readDesktopInvocationAdmissionDiagnostic({ ...group }, other),
      ).toBeNull();
  });

  it("never runs an accessor and survives a throwing proxy", () => {
    let reads = 0;
    const accessor = { ...group };
    Object.defineProperty(accessor, "desktop_invocation_admission_reason", {
      enumerable: true,
      get() {
        reads++;
        return "stdin_encoding_invalid";
      },
    });
    expect(
      readDesktopInvocationAdmissionDiagnostic(accessor, rejection),
    ).toBeNull();
    expect(reads).toBe(0);
    const fail = () => {
      throw new Error("PRIVATE");
    };
    expect(
      readDesktopInvocationAdmissionDiagnostic(
        new Proxy(
          { ...group },
          { get: fail, getOwnPropertyDescriptor: fail, ownKeys: fail },
        ),
        rejection,
      ),
    ).toBeNull();
  });
});

describe("desktopInvocationRejectionDiagnostic", () => {
  it.each([
    "authorization_id_invalid",
    "authorization_precondition",
    "authorization_unavailable",
    "authorization_not_approved",
    "authorization_response_invalid",
    "operation_rejected",
  ])("accepts %s only from the authorized command", (reason) => {
    expect(
      desktopInvocationRejectionDiagnostic(reason, "authorized_native"),
    ).toEqual({
      desktop_invocation_rejection_version: 1,
      desktop_invocation_rejection_reason: reason,
      desktop_invocation_rejection_adapter: "authorized_native",
    });
    for (const adapter of [
      "compatibility_native",
      "published_legacy_native",
      "not_selected",
    ])
      expect(desktopInvocationRejectionDiagnostic(reason, adapter)).toBeNull();
  });

  it("accepts only unknown when no command set was selected", () => {
    expect(
      desktopInvocationRejectionDiagnostic("unknown", "not_selected"),
    ).toEqual({
      desktop_invocation_rejection_version: 1,
      desktop_invocation_rejection_reason: "unknown",
      desktop_invocation_rejection_adapter: "not_selected",
    });
    for (const reason of ["execution_admission", "spawn_failed"])
      expect(
        desktopInvocationRejectionDiagnostic(reason, "not_selected"),
      ).toBeNull();
  });

  it.each(["execution_admission", "spawn_failed", "unknown"])(
    "accepts %s from every native command set",
    (reason) => {
      for (const adapter of [
        "authorized_native",
        "compatibility_native",
        "published_legacy_native",
      ]) {
        const group = desktopInvocationRejectionDiagnostic(reason, adapter);
        expect(group).toMatchObject({
          desktop_invocation_rejection_reason: reason,
          desktop_invocation_rejection_adapter: adapter,
        });
        expect(Object.isFrozen(group)).toBe(true);
      }
    },
  );

  it.each<[unknown, unknown]>([
    ["unknown", undefined],
    ["unknown", "legacy_loopback"],
    ["unknown", "PRIVATE"],
    ["PRIVATE", "authorized_native"],
    ["Desktop operation was not authorized", "authorized_native"],
    [undefined, "authorized_native"],
  ])("builds nothing for reason %p and adapter %p", (reason, adapter) => {
    expect(desktopInvocationRejectionDiagnostic(reason, adapter)).toBeNull();
  });
});

describe("readDesktopInvocationRejectionDiagnostic", () => {
  const group = {
    desktop_invocation_rejection_version: 1,
    desktop_invocation_rejection_reason: "authorization_not_approved",
    desktop_invocation_rejection_adapter: "authorized_native",
  };

  it("copies only the complete group's data values", () => {
    const read = readDesktopInvocationRejectionDiagnostic({
      ...group,
      message: "PRIVATE",
    });
    expect(read).toEqual(group);
    expect(Object.isFrozen(read)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["no source", undefined],
    ["a string source", "PRIVATE"],
    ["an empty bag", {}],
    [
      "a missing reason",
      { ...group, desktop_invocation_rejection_reason: undefined },
    ],
    [
      "a missing adapter",
      { ...group, desktop_invocation_rejection_adapter: undefined },
    ],
    [
      "a missing version",
      { ...group, desktop_invocation_rejection_version: undefined },
    ],
    [
      "an unsupported version",
      { ...group, desktop_invocation_rejection_version: 2 },
    ],
    [
      "a string version",
      { ...group, desktop_invocation_rejection_version: "1" },
    ],
    [
      "a raw native message as reason",
      {
        ...group,
        desktop_invocation_rejection_reason:
          "Desktop operation was not authorized",
      },
    ],
    [
      "an authorization reason from a legacy command",
      {
        ...group,
        desktop_invocation_rejection_adapter: "published_legacy_native",
      },
    ],
    [
      "the file loopback adapter",
      {
        ...group,
        desktop_invocation_rejection_reason: "unknown",
        desktop_invocation_rejection_adapter: "legacy_loopback",
      },
    ],
    [
      "a native class without a selected command set",
      {
        ...group,
        desktop_invocation_rejection_reason: "spawn_failed",
        desktop_invocation_rejection_adapter: "not_selected",
      },
    ],
    [
      "an inherited group",
      Object.create(group as object) as Record<string, unknown>,
    ],
  ])("reads nothing for %s", (_case, source) => {
    expect(readDesktopInvocationRejectionDiagnostic(source)).toBeNull();
  });

  it("never runs an accessor and survives a throwing proxy", () => {
    let reads = 0;
    const accessor = { ...group };
    Object.defineProperty(accessor, "desktop_invocation_rejection_reason", {
      enumerable: true,
      get() {
        reads++;
        return "unknown";
      },
    });
    expect(readDesktopInvocationRejectionDiagnostic(accessor)).toBeNull();
    expect(reads).toBe(0);
    const fail = () => {
      throw new Error("PRIVATE");
    };
    expect(
      readDesktopInvocationRejectionDiagnostic(
        new Proxy(
          { ...group },
          { get: fail, getOwnPropertyDescriptor: fail, ownKeys: fail },
        ),
      ),
    ).toBeNull();
  });
});
