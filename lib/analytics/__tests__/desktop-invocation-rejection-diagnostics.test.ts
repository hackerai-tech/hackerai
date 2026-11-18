import {
  classifyNativeInvocationRejection,
  classifyNativeInvocationRejectionMessage,
  desktopInvocationAdmissionDiagnostic,
  desktopInvocationRejectionDiagnostic,
  desktopInvocationSpawnHintDiagnostic,
  desktopInvocationUnknownDiagnostic,
  desktopStreamFenceDiagnostic,
  parseNativeStreamFenceRejection,
  readDesktopInvocationAdmissionDiagnostic,
  readDesktopInvocationRejectionDiagnostic,
  readDesktopInvocationSpawnHintDiagnostic,
  readDesktopInvocationUnknownDiagnostic,
  readDesktopStreamFenceDiagnostic,
  type DesktopInvocationRejectionDiagnostic,
  type DesktopInvocationUnknownDiagnostic,
} from "../desktop-invocation-rejection-diagnostics";

const unclassified = (unknownClass: string) => ({
  reason: "unknown",
  admission: null,
  spawnOsCodeHint: null,
  unknownClass,
});

// stream_lifecycle.rs, verbatim.
const PAGE_REPLACED = "Desktop page was replaced before this command started";
const PRIOR_CLEANUP =
  "Desktop is still stopping commands from a previous page. Retry shortly.";
const STOP_UNCONFIRMED =
  "Desktop could not confirm an earlier command stopped. New commands are blocked for this session. Close and reopen Desktop before running more commands.";

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
  ])("classifies %p as %s and %s", (message, reason, admission) => {
    const expected = {
      reason,
      admission,
      spawnOsCodeHint: null,
      unknownClass: null,
    };
    expect(classifyNativeInvocationRejection(message)).toBe(reason);
    expect(classifyNativeInvocationRejectionMessage(message)).toEqual(expected);
    // A real Error's own message is read the same way.
    expect(classifyNativeInvocationRejection(new Error(message))).toBe(reason);
    expect(
      classifyNativeInvocationRejectionMessage(new Error(message)),
    ).toEqual(expected);
  });

  // Rust's io::Error Display ends an OS error with " (os error N)". Only that
  // exact final suffix for a reviewed code is a hint; the text before it is
  // never interpreted.
  it.each<[string, string]>([
    ["Failed to spawn: PRIVATE (os error 2)", "code_2"],
    ["Failed to spawn: PRIVATE (os error 3)", "code_3"],
    ["Failed to spawn: PRIVATE (os error 5)", "code_5"],
    ["Failed to spawn: PRIVATE (os error 32)", "code_32"],
    ["Failed to spawn: PRIVATE (os error 87)", "code_87"],
    ["Failed to spawn: PRIVATE (os error 193)", "code_193"],
    ["Failed to spawn: PRIVATE (os error 206)", "code_206"],
    ["Failed to spawn: PRIVATE (os error 267)", "code_267"],
    ["Failed to spawn: PRIVATE (os error 740)", "code_740"],
    ["Failed to spawn: PRIVATE (os error 1260)", "code_1260"],
    // Only the final suffix counts, not one earlier in the OS text.
    ["Failed to spawn: PRIVATE (os error 5) (os error 2)", "code_2"],
    // Every other bounded spawn message is the noncausal `unrecognized`.
    ["Failed to spawn: ", "unrecognized"],
    ["Failed to spawn: PRIVATE", "unrecognized"],
    ["Failed to spawn: (os error 2)", "unrecognized"],
    ["Failed to spawn: PRIVATE (os error 4)", "unrecognized"],
    ["Failed to spawn: PRIVATE (os error 12)", "unrecognized"],
    ["Failed to spawn: PRIVATE (os error 02)", "unrecognized"],
    ["Failed to spawn: PRIVATE (os error -2)", "unrecognized"],
    ["Failed to spawn: PRIVATE (os error 2) ", "unrecognized"],
    ["Failed to spawn: PRIVATE (os error 2)\n", "unrecognized"],
    ["Failed to spawn: PRIVATE (os error 2).", "unrecognized"],
    ["Failed to spawn: PRIVATE (os error 2) PRIVATE", "unrecognized"],
    ["Failed to spawn: PRIVATE (OS error 2)", "unrecognized"],
    ["Failed to spawn: PRIVATE (os error 2", "unrecognized"],
    ["Failed to spawn: PRIVATE(os error 2)", "unrecognized"],
    ["Failed to spawn: PRIVATE (os error ２)", "unrecognized"],
    // Exactly the 1024-character bound.
    [`Failed to spawn: ${"x".repeat(994)} (os error 2)`, "code_2"],
  ])("hints spawn message %p as %s", (message, hint) => {
    const expected = {
      reason: "spawn_failed",
      admission: null,
      spawnOsCodeHint: hint,
      unknownClass: null,
    };
    expect(classifyNativeInvocationRejectionMessage(message)).toEqual(expected);
    expect(
      classifyNativeInvocationRejectionMessage(new Error(message)),
    ).toEqual(expected);
  });

  it.each<[string, string]>([
    // One character over the bound.
    [`Failed to spawn: ${"x".repeat(995)} (os error 2)`, "message_over_limit"],
    ["PRIVATE Failed to spawn: x (os error 2)", "other_string"],
    ["failed to spawn: x (os error 2)", "other_string"],
    ["Process error: x (os error 2)", "other_string"],
    ["Desktop operation was not authorized (os error 2)", "other_string"],
  ])(
    "hints nothing for a spawn suffix outside a bounded spawn message %p",
    (message, unknownClass) => {
      expect(classifyNativeInvocationRejectionMessage(message)).toEqual(
        unclassified(unknownClass),
      );
    },
  );

  it.each<[string, unknown, string]>([
    [
      "a trailing space",
      "Desktop operation was not authorized ",
      "other_string",
    ],
    [
      "a leading space",
      " Desktop operation was not authorized",
      "other_string",
    ],
    [
      "a trailing newline",
      "Invalid Desktop operation authorization\n",
      "other_string",
    ],
    ["a case change", "desktop operation was not authorized", "other_string"],
    ["a truncated message", "Desktop operation was not", "other_string"],
    ["an appended suffix", "Invalid Desktop operation PRIVATE", "other_string"],
    [
      "a spawn message without its separator",
      "Failed to spawn PRIVATE",
      "other_string",
    ],
    ["a lower-case spawn message", "failed to spawn: PRIVATE", "other_string"],
    ["an embedded spawn message", "PRIVATE Failed to spawn: x", "other_string"],
    [
      "an over-long spawn message",
      `Failed to spawn: ${"PRIVATE".repeat(200)}`,
      "message_over_limit",
    ],
    // Tauri runtime and stream-event messages are not rejection classes here.
    [
      "a Tauri ACL message",
      "Command execute_authorized_stream_command not allowed by ACL",
      "other_string",
    ],
    [
      "a Tauri missing command",
      "Command execute_stream_command not found",
      "other_string",
    ],
    [
      "a native timeout event",
      "Command timed out after 30000ms",
      "other_string",
    ],
    ["a native process event", "Process error: PRIVATE", "other_string"],
    ["an empty message", "", "other_string"],
    ["undefined", undefined, "message_unavailable"],
    ["null", null, "message_unavailable"],
    ["a number", 42, "message_unavailable"],
    [
      "a plain object with a known message",
      { message: "Desktop operation was not authorized" },
      "message_unavailable",
    ],
    [
      "an object that stringifies to a known message",
      { toString: () => "Desktop operation was not authorized" },
      "message_unavailable",
    ],
    // Changed admission templates never fall back to a nearby class.
    [
      "a punctuated admission message",
      "Command is already running.",
      "other_string",
    ],
    [
      "a sized stdin message",
      "Command stdin exceeds limit: 4096",
      "other_string",
    ],
    [
      "a truncated update message",
      "Desktop is installing an update.",
      "other_string",
    ],
    [
      "a lower-case admission message",
      "command is already running",
      "other_string",
    ],
    [
      "an over-long admission message",
      `Command is already running${" ".repeat(1024)}`,
      "message_over_limit",
    ],
    [
      "a plain object with an admission message",
      { message: "Invalid command stdin encoding" },
      "message_unavailable",
    ],
    [
      "an object that stringifies to an admission message",
      { toString: () => "Command stdin exceeds limit" },
      "message_unavailable",
    ],
    [
      "an Error inheriting an admission message",
      (() => {
        class InheritedError extends Error {}
        InheritedError.prototype.message = "Command is already running";
        return new InheritedError();
      })(),
      "message_unavailable",
    ],
  ])("classifies %s as unknown", (_case, error, unknownClass) => {
    expect(classifyNativeInvocationRejection(error)).toBe("unknown");
    expect(classifyNativeInvocationRejectionMessage(error)).toEqual(
      unclassified(unknownClass),
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
    const spawnGetter = new Error("Failed to spawn: x (os error 2)");
    Object.defineProperty(spawnGetter, "message", {
      get() {
        reads++;
        return "Failed to spawn: x (os error 5)";
      },
    });
    const lifecycleGetter = new Error(PAGE_REPLACED);
    Object.defineProperty(lifecycleGetter, "message", {
      get() {
        reads++;
        return STOP_UNCONFIRMED;
      },
    });
    const fail = () => {
      throw new Error("PRIVATE");
    };
    for (const error of [
      new GetterError(),
      stringified,
      spawnGetter,
      lifecycleGetter,
      {
        toString() {
          reads++;
          return "Failed to spawn: x (os error 2)";
        },
      },
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
      new Proxy(new Error(PRIOR_CLEANUP), {
        get: fail,
        getOwnPropertyDescriptor: fail,
      }),
    ]) {
      expect(classifyNativeInvocationRejection(error)).toBe("unknown");
      expect(classifyNativeInvocationRejectionMessage(error)).toEqual(
        unclassified("message_unavailable"),
      );
    }
    expect(reads).toBe(0);
  });
});

describe("unknown invocation class", () => {
  // The three stream_lifecycle.rs admission denials as Tauri rejects them, and
  // as an Error's own data message; the coarse reason stays `unknown`.
  it.each<[string, string]>([
    [PAGE_REPLACED, "lifecycle_page_replaced"],
    [PRIOR_CLEANUP, "lifecycle_prior_cleanup_pending"],
    [STOP_UNCONFIRMED, "lifecycle_stop_unconfirmed"],
  ])("classifies the exact lifecycle message %p as %s", (message, cls) => {
    for (const error of [message, new Error(message)]) {
      expect(classifyNativeInvocationRejection(error)).toBe("unknown");
      expect(classifyNativeInvocationRejectionMessage(error)).toEqual(
        unclassified(cls),
      );
    }
  });

  // Exact equality only: near misses are another message, never a guess.
  it.each<[string, string]>([
    ["a prefix", "Desktop page was replaced"],
    ["the first stop sentence", STOP_UNCONFIRMED.split(". ")[0] + "."],
    ["a trailing space", `${PAGE_REPLACED} `],
    ["a trailing newline", `${PRIOR_CLEANUP}\n`],
    ["a leading space", ` ${STOP_UNCONFIRMED}`],
    ["a case change", PAGE_REPLACED.toLowerCase()],
    ["a missing final period", PRIOR_CLEANUP.slice(0, -1)],
    ["a wrapped message", `Error: ${PAGE_REPLACED}`],
    ["an appended detail", `${STOP_UNCONFIRMED} PRIVATE`],
    ["two concatenated messages", `${PAGE_REPLACED}${PRIOR_CLEANUP}`],
    ["an unrelated private string", "PRIVATE canary /Users/PRIVATE/cwd"],
  ])("classifies %s as another message by its source", (_case, message) => {
    expect(classifyNativeInvocationRejectionMessage(message)).toEqual(
      unclassified("other_string"),
    );
    expect(
      classifyNativeInvocationRejectionMessage(new Error(message)),
    ).toEqual(unclassified("other_error_message"));
  });

  it("keeps a coarse class for a spawn message quoting a lifecycle message", () => {
    expect(
      classifyNativeInvocationRejectionMessage(
        `Failed to spawn: ${PAGE_REPLACED}`,
      ),
    ).toEqual({
      reason: "spawn_failed",
      admission: null,
      spawnOsCodeHint: "unrecognized",
      unknownClass: null,
    });
  });

  it("bounds an unlisted message at exactly 1024 characters", () => {
    for (const [length, cls] of [
      [1024, "other_string"],
      [1025, "message_over_limit"],
    ] as const) {
      const message = "x".repeat(length);
      expect(classifyNativeInvocationRejectionMessage(message)).toEqual(
        unclassified(cls),
      );
      expect(
        classifyNativeInvocationRejectionMessage(new Error(message)),
      ).toEqual(
        unclassified(
          cls === "other_string" ? "other_error_message" : "message_over_limit",
        ),
      );
    }
    // An over-long message is never compared, even with a lifecycle start.
    expect(
      classifyNativeInvocationRejectionMessage(
        STOP_UNCONFIRMED.padEnd(1025, " "),
      ),
    ).toEqual(unclassified("message_over_limit"));
  });

  it.each<[string, () => unknown]>([
    [
      "an Error inheriting a lifecycle message",
      () => {
        class InheritedError extends Error {}
        InheritedError.prototype.message = PAGE_REPLACED;
        return new InheritedError();
      },
    ],
    [
      "an Error whose own message is not a string",
      () => {
        const error = new Error("x");
        Object.defineProperty(error, "message", { value: 42 });
        return error;
      },
    ],
    ["a plain lifecycle object", () => ({ message: PAGE_REPLACED })],
    ["a boxed lifecycle string", () => Object(PAGE_REPLACED) as unknown],
    ["a symbol", () => Symbol(PAGE_REPLACED)],
    [
      "a cyclic plain object",
      () => {
        const value: Record<string, unknown> = { message: STOP_UNCONFIRMED };
        value.self = value;
        return value;
      },
    ],
  ])("classifies %s as message_unavailable", (_case, make) => {
    expect(classifyNativeInvocationRejectionMessage(make())).toEqual(
      unclassified("message_unavailable"),
    );
  });

  it("reads a cyclic Error's own message without following its cause", () => {
    const error = new Error(STOP_UNCONFIRMED) as Error & { cause?: unknown };
    error.cause = error;
    expect(classifyNativeInvocationRejectionMessage(error)).toEqual(
      unclassified("lifecycle_stop_unconfirmed"),
    );
  });

  it("reads the message descriptor once and never its value through get", () => {
    let descriptorReads = 0;
    let gets = 0;
    const counted = new Proxy(new Error(PRIOR_CLEANUP), {
      get(target, key, receiver) {
        gets++;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === "message") descriptorReads++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(classifyNativeInvocationRejectionMessage(counted)).toEqual(
      unclassified("lifecycle_prior_cleanup_pending"),
    );
    expect(descriptorReads).toBe(1);
    expect(gets).toBe(0);
  });

  it("never echoes the message in any class", () => {
    const canary = "PRIVATE canary C:\\Users\\PRIVATE";
    for (const error of [
      canary,
      new Error(canary),
      canary.repeat(100),
      { message: canary },
    ])
      expect(
        JSON.stringify(classifyNativeInvocationRejectionMessage(error)),
      ).not.toContain("PRIVATE");
  });
});

describe("desktopInvocationUnknownDiagnostic", () => {
  const classes = [
    "lifecycle_page_replaced",
    "lifecycle_prior_cleanup_pending",
    "lifecycle_stop_unconfirmed",
    "other_string",
    "other_error_message",
    "message_over_limit",
    "message_unavailable",
  ];
  const authorizedUnknown = desktopInvocationRejectionDiagnostic(
    "unknown",
    "authorized_native",
  );

  it.each(classes)("refines an authorized unknown with %s", (cls) => {
    const group = desktopInvocationUnknownDiagnostic(authorizedUnknown, cls);
    expect(group).toEqual({
      desktop_invocation_unknown_version: 1,
      desktop_invocation_unknown_class: cls,
    });
    expect(Object.isFrozen(group)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["no class", null],
    [
      "a compatibility unknown",
      desktopInvocationRejectionDiagnostic("unknown", "compatibility_native"),
    ],
    [
      "a published legacy unknown",
      desktopInvocationRejectionDiagnostic(
        "unknown",
        "published_legacy_native",
      ),
    ],
    [
      "an unselected unknown",
      desktopInvocationRejectionDiagnostic("unknown", "not_selected"),
    ],
    [
      "an authorized spawn failure",
      desktopInvocationRejectionDiagnostic("spawn_failed", "authorized_native"),
    ],
    [
      "an authorized admission rejection",
      desktopInvocationRejectionDiagnostic(
        "execution_admission",
        "authorized_native",
      ),
    ],
    [
      "an authorized approval rejection",
      desktopInvocationRejectionDiagnostic(
        "authorization_not_approved",
        "authorized_native",
      ),
    ],
  ])("never refines %s", (_case, rejection) => {
    for (const cls of classes)
      expect(
        desktopInvocationUnknownDiagnostic(
          rejection as DesktopInvocationRejectionDiagnostic | null,
          cls,
        ),
      ).toBeNull();
  });

  it.each<[string, unknown]>([
    ["no class", null],
    ["an undefined class", undefined],
    ["the coarse reason", "unknown"],
    ["a raw lifecycle message", PAGE_REPLACED],
    ["a private value", "PRIVATE"],
    ["a number", 1],
  ])("builds nothing for %s", (_case, cls) => {
    expect(
      desktopInvocationUnknownDiagnostic(authorizedUnknown, cls),
    ).toBeNull();
  });
});

describe("readDesktopInvocationUnknownDiagnostic", () => {
  const authorizedUnknown = desktopInvocationRejectionDiagnostic(
    "unknown",
    "authorized_native",
  );
  const group = {
    desktop_invocation_unknown_version: 1,
    desktop_invocation_unknown_class: "lifecycle_stop_unconfirmed",
  };

  it("copies only the complete group's data values", () => {
    const read = readDesktopInvocationUnknownDiagnostic(
      { ...group, message: STOP_UNCONFIRMED, cwd: "PRIVATE" },
      authorizedUnknown,
    );
    expect(read).toEqual(group);
    expect(Object.isFrozen(read)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["no source", undefined],
    ["a string source", "PRIVATE"],
    ["an empty bag", {}],
    [
      "a missing class",
      { ...group, desktop_invocation_unknown_class: undefined },
    ],
    [
      "a missing version",
      { ...group, desktop_invocation_unknown_version: undefined },
    ],
    ["a string version", { ...group, desktop_invocation_unknown_version: "1" }],
    [
      "an unsupported version",
      { ...group, desktop_invocation_unknown_version: 2 },
    ],
    [
      "a raw lifecycle message as class",
      { ...group, desktop_invocation_unknown_class: STOP_UNCONFIRMED },
    ],
    [
      "an unlisted class",
      { ...group, desktop_invocation_unknown_class: "lifecycle_other" },
    ],
    [
      "an inherited group",
      Object.create(group as object) as Record<string, unknown>,
    ],
  ])("reads nothing for %s", (_case, source) => {
    expect(
      readDesktopInvocationUnknownDiagnostic(source, authorizedUnknown),
    ).toBeNull();
  });

  it("never reads a source without a validated authorized unknown class", () => {
    const fail = () => {
      throw new Error("PRIVATE");
    };
    const hostile = new Proxy(
      { ...group },
      { get: fail, getOwnPropertyDescriptor: fail, ownKeys: fail },
    );
    let reads = 0;
    const counted = new Proxy(
      { ...group },
      {
        getOwnPropertyDescriptor(target, key) {
          reads++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    for (const other of [
      null,
      desktopInvocationRejectionDiagnostic("unknown", "not_selected"),
      desktopInvocationRejectionDiagnostic("unknown", "compatibility_native"),
      desktopInvocationRejectionDiagnostic("spawn_failed", "authorized_native"),
      // A forged unvalidated group naming another adapter never qualifies.
      {
        desktop_invocation_rejection_version: 1,
        desktop_invocation_rejection_reason: "unknown",
        desktop_invocation_rejection_adapter: "legacy_loopback",
      } as unknown as DesktopInvocationRejectionDiagnostic,
    ]) {
      expect(readDesktopInvocationUnknownDiagnostic(hostile, other)).toBeNull();
      expect(readDesktopInvocationUnknownDiagnostic(counted, other)).toBeNull();
    }
    expect(reads).toBe(0);
  });

  it("never runs an accessor and survives a throwing proxy", () => {
    let reads = 0;
    const accessor = { ...group };
    Object.defineProperty(accessor, "desktop_invocation_unknown_class", {
      enumerable: true,
      get() {
        reads++;
        return "lifecycle_page_replaced";
      },
    });
    expect(
      readDesktopInvocationUnknownDiagnostic(accessor, authorizedUnknown),
    ).toBeNull();
    expect(reads).toBe(0);
    const fail = () => {
      throw new Error("PRIVATE");
    };
    expect(
      readDesktopInvocationUnknownDiagnostic(
        new Proxy(
          { ...group },
          { get: fail, getOwnPropertyDescriptor: fail, ownKeys: fail },
        ),
        authorizedUnknown,
      ),
    ).toBeNull();
  });
});

describe("stream fence origin", () => {
  const origins = [
    "owner_timeout",
    "owner_process_error",
    "owner_stop_requested",
    "owner_delivery_failed",
    "owner_outcome_missing",
    "cancel_wait_timeout",
  ];
  const authorizedUnknown = desktopInvocationRejectionDiagnostic(
    "unknown",
    "authorized_native",
  );
  const stopUnconfirmed = desktopInvocationUnknownDiagnostic(
    authorizedUnknown,
    "lifecycle_stop_unconfirmed",
  );
  const group = {
    desktop_stream_fence_version: 1,
    desktop_stream_fence_origin: "owner_timeout",
  };

  const rejection = (streamFence: unknown) => ({
    message: STOP_UNCONFIRMED,
    streamFence,
  });

  it.each(origins)(
    "unwraps the exact message and joins the closed %s origin",
    (origin) => {
      const parsed = parseNativeStreamFenceRejection(
        rejection({ version: 1, origin }),
      );
      expect(parsed).toEqual({ message: STOP_UNCONFIRMED, origin });
      expect(Object.isFrozen(parsed)).toBe(true);
      // The unwrapped message classifies exactly as the original string.
      expect(classifyNativeInvocationRejectionMessage(parsed!.message)).toEqual(
        classifyNativeInvocationRejectionMessage(STOP_UNCONFIRMED),
      );
      const diagnostic = desktopStreamFenceDiagnostic(
        authorizedUnknown,
        stopUnconfirmed,
        parsed!.origin,
      );
      expect(diagnostic).toEqual({
        desktop_stream_fence_version: 1,
        desktop_stream_fence_origin: origin,
      });
      expect(Object.isFrozen(diagnostic)).toBe(true);
    },
  );

  it.each<[string, () => unknown]>([
    ["an unlisted origin", () => ({ version: 1, origin: "PRIVATE" })],
    ["a numeric origin", () => ({ version: 1, origin: 0 })],
    ["an unsupported version", () => ({ version: 2, origin: "owner_timeout" })],
    ["a string version", () => ({ version: "1", origin: "owner_timeout" })],
    ["a missing version", () => ({ origin: "owner_timeout" })],
    ["a missing origin", () => ({ version: 1 })],
    [
      "an extra field",
      () => ({ version: 1, origin: "owner_timeout", pid: 4242 }),
    ],
    [
      "an extra symbol",
      () => ({ version: 1, origin: "owner_timeout", [Symbol("x")]: 1 }),
    ],
    [
      "an inherited origin",
      () => Object.create({ version: 1, origin: "owner_timeout" }),
    ],
    [
      "a null-prototype origin",
      () =>
        Object.assign(Object.create(null), {
          version: 1,
          origin: "owner_timeout",
        }),
    ],
    ["a string", () => "owner_timeout"],
    ["an array", () => [1, "owner_timeout"]],
    ["null", () => null],
  ])("keeps only the exact message beside %s", (_case, streamFence) => {
    expect(parseNativeStreamFenceRejection(rejection(streamFence()))).toEqual({
      message: STOP_UNCONFIRMED,
      origin: null,
    });
  });

  it.each<[string, () => unknown]>([
    ["the original string", () => STOP_UNCONFIRMED],
    ["an Error", () => new Error(STOP_UNCONFIRMED)],
    ["null", () => null],
    ["an array", () => [STOP_UNCONFIRMED, { version: 1, origin: "x" }]],
    [
      "another lifecycle message",
      () => ({
        message: PAGE_REPLACED,
        streamFence: { version: 1, origin: "owner_timeout" },
      }),
    ],
    [
      "a message with a private suffix",
      () => ({
        message: `${STOP_UNCONFIRMED} PRIVATE`,
        streamFence: { version: 1, origin: "owner_timeout" },
      }),
    ],
    ["a missing origin", () => ({ message: STOP_UNCONFIRMED })],
    [
      "an extra field",
      () => ({
        ...rejection({ version: 1, origin: "owner_timeout" }),
        pid: 4242,
      }),
    ],
    [
      "an inherited rejection",
      () => Object.create(rejection({ version: 1, origin: "owner_timeout" })),
    ],
  ])("reads nothing from %s", (_case, error) => {
    expect(parseNativeStreamFenceRejection(error())).toBeNull();
  });

  it("never runs an accessor and survives a throwing proxy", () => {
    let reads = 0;
    const counted = (target: Record<string, unknown>, key: string) => {
      const value = target[key];
      Object.defineProperty(target, key, {
        enumerable: true,
        get() {
          reads++;
          return value;
        },
      });
      return target;
    };
    expect(
      parseNativeStreamFenceRejection(
        counted(rejection({ version: 1, origin: "owner_timeout" }), "message"),
      ),
    ).toBeNull();
    expect(
      parseNativeStreamFenceRejection(
        rejection(counted({ version: 1, origin: "owner_timeout" }, "origin")),
      ),
    ).toEqual({ message: STOP_UNCONFIRMED, origin: null });
    expect(reads).toBe(0);
    const fail = () => {
      throw new Error("PRIVATE");
    };
    const hostile = () =>
      new Proxy(rejection({ version: 1, origin: "owner_timeout" }), {
        getPrototypeOf: fail,
        ownKeys: fail,
        get: fail,
        getOwnPropertyDescriptor: fail,
      });
    expect(parseNativeStreamFenceRejection(hostile())).toBeNull();
    expect(parseNativeStreamFenceRejection(rejection(hostile()))).toEqual({
      message: STOP_UNCONFIRMED,
      origin: null,
    });
  });

  it.each<[string, unknown, unknown]>([
    ["no rejection", null, stopUnconfirmed],
    ["no unknown class", authorizedUnknown, null],
    [
      "a page replacement class",
      authorizedUnknown,
      desktopInvocationUnknownDiagnostic(
        authorizedUnknown,
        "lifecycle_page_replaced",
      ),
    ],
    [
      "a prior cleanup class",
      authorizedUnknown,
      desktopInvocationUnknownDiagnostic(
        authorizedUnknown,
        "lifecycle_prior_cleanup_pending",
      ),
    ],
    [
      "an other string class",
      authorizedUnknown,
      desktopInvocationUnknownDiagnostic(authorizedUnknown, "other_string"),
    ],
    [
      "a compatibility unknown",
      desktopInvocationRejectionDiagnostic("unknown", "compatibility_native"),
      stopUnconfirmed,
    ],
    [
      "a published legacy unknown",
      desktopInvocationRejectionDiagnostic(
        "unknown",
        "published_legacy_native",
      ),
      stopUnconfirmed,
    ],
    [
      "an authorized approval rejection",
      desktopInvocationRejectionDiagnostic(
        "authorization_not_approved",
        "authorized_native",
      ),
      stopUnconfirmed,
    ],
    [
      "a forged unknown group of another version",
      authorizedUnknown,
      {
        desktop_invocation_unknown_version: 2,
        desktop_invocation_unknown_class: "lifecycle_stop_unconfirmed",
      },
    ],
  ])("never joins %s", (_case, rejection, unknown) => {
    const groups = [
      rejection as DesktopInvocationRejectionDiagnostic | null,
      unknown as DesktopInvocationUnknownDiagnostic | null,
    ] as const;
    for (const origin of origins) {
      expect(desktopStreamFenceDiagnostic(...groups, origin)).toBeNull();
      expect(
        readDesktopStreamFenceDiagnostic(
          { ...group, desktop_stream_fence_origin: origin },
          ...groups,
        ),
      ).toBeNull();
    }
  });

  it("reads only the complete group's own data values within the gate", () => {
    const read = readDesktopStreamFenceDiagnostic(
      { ...group, message: "PRIVATE", pid: 4242 },
      authorizedUnknown,
      stopUnconfirmed,
    );
    expect(read).toEqual(group);
    expect(Object.isFrozen(read)).toBe(true);
    for (const source of [
      undefined,
      "PRIVATE",
      {},
      { ...group, desktop_stream_fence_version: 2 },
      { ...group, desktop_stream_fence_version: "1" },
      { ...group, desktop_stream_fence_origin: "PRIVATE" },
      { ...group, desktop_stream_fence_origin: undefined },
      Object.create(group),
    ])
      expect(
        readDesktopStreamFenceDiagnostic(
          source,
          authorizedUnknown,
          stopUnconfirmed,
        ),
      ).toBeNull();
  });

  it("never reads a source outside the gate or runs an accessor within it", () => {
    let reads = 0;
    const counted = new Proxy(
      { ...group },
      {
        getOwnPropertyDescriptor(target, key) {
          reads++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const pageReplaced = desktopInvocationUnknownDiagnostic(
      authorizedUnknown,
      "lifecycle_page_replaced",
    );
    expect(
      readDesktopStreamFenceDiagnostic(
        counted,
        authorizedUnknown,
        pageReplaced,
      ),
    ).toBeNull();
    expect(
      readDesktopStreamFenceDiagnostic(counted, null, stopUnconfirmed),
    ).toBeNull();
    expect(reads).toBe(0);

    let gets = 0;
    const accessor = { ...group } as Record<string, unknown>;
    Object.defineProperty(accessor, "desktop_stream_fence_origin", {
      enumerable: true,
      get() {
        gets++;
        return "owner_timeout";
      },
    });
    expect(
      readDesktopStreamFenceDiagnostic(
        accessor,
        authorizedUnknown,
        stopUnconfirmed,
      ),
    ).toBeNull();
    expect(gets).toBe(0);
    const fail = () => {
      throw new Error("PRIVATE");
    };
    expect(
      readDesktopStreamFenceDiagnostic(
        new Proxy(
          { ...group },
          { get: fail, getOwnPropertyDescriptor: fail, ownKeys: fail },
        ),
        authorizedUnknown,
        stopUnconfirmed,
      ),
    ).toBeNull();
  });

  describe("stop cleanup failure", () => {
    const failures = [
      "tree_unconfirmed",
      "leader_wait_timed_out",
      "leader_wait_failed",
      "tree_and_leader_wait_timed_out",
      "tree_and_leader_wait_failed",
    ];
    const stop = { version: 1, origin: "owner_stop_requested" };
    const sibling = (
      streamFenceCleanup: unknown,
      streamFence: unknown = stop,
    ) => ({
      message: STOP_UNCONFIRMED,
      streamFence,
      streamFenceCleanup,
    });
    const stopGroup = {
      desktop_stream_fence_version: 1,
      desktop_stream_fence_origin: "owner_stop_requested",
    };
    const cleanupGroup = {
      desktop_stream_fence_cleanup_version: 1,
      desktop_stream_fence_cleanup_failure: "tree_unconfirmed",
    };
    // Counts every own-key, descriptor, prototype or value access.
    const watched = (target: object) => {
      const reads = { count: 0 };
      const count = <T>(value: T) => {
        reads.count++;
        return value;
      };
      const proxy = new Proxy(target, {
        get: (object, key) => count(Reflect.get(object, key)),
        getOwnPropertyDescriptor: (object, key) =>
          count(Reflect.getOwnPropertyDescriptor(object, key)),
        getPrototypeOf: (object) => count(Reflect.getPrototypeOf(object)),
        ownKeys: (object) => count(Reflect.ownKeys(object)),
      });
      return { proxy, reads };
    };

    it.each(failures)(
      "unwraps the exact message beside the stop origin and its %s failure",
      (failure) => {
        const parsed = parseNativeStreamFenceRejection(
          sibling({ version: 1, failure }),
        );
        expect(parsed).toEqual({
          message: STOP_UNCONFIRMED,
          origin: "owner_stop_requested",
          cleanupFailure: failure,
        });
        expect(Object.isFrozen(parsed)).toBe(true);
        const diagnostic = desktopStreamFenceDiagnostic(
          authorizedUnknown,
          stopUnconfirmed,
          parsed!.origin,
          parsed!.cleanupFailure,
        );
        expect(diagnostic).toEqual({
          ...stopGroup,
          desktop_stream_fence_cleanup_version: 1,
          desktop_stream_fence_cleanup_failure: failure,
        });
        expect(Object.isFrozen(diagnostic)).toBe(true);
      },
    );

    it("keeps the exact v1 shape from an older native app unchanged", () => {
      const parsed = parseNativeStreamFenceRejection(rejection(stop));
      expect(parsed).toEqual({
        message: STOP_UNCONFIRMED,
        origin: "owner_stop_requested",
      });
      expect(parsed).not.toHaveProperty("cleanupFailure");
      expect(
        desktopStreamFenceDiagnostic(
          authorizedUnknown,
          stopUnconfirmed,
          parsed!.origin,
          parsed!.cleanupFailure,
        ),
      ).toEqual(stopGroup);
    });

    it.each(origins.filter((origin) => origin !== "owner_stop_requested"))(
      "never reads a cleanup sibling beside the %s origin",
      (origin) => {
        const cleanup = watched({ version: 1, failure: "tree_unconfirmed" });
        const parsed = parseNativeStreamFenceRejection(
          sibling(cleanup.proxy, { version: 1, origin }),
        );
        expect(parsed).toEqual({ message: STOP_UNCONFIRMED, origin });
        expect(parsed).not.toHaveProperty("cleanupFailure");
        expect(cleanup.reads.count).toBe(0);
        // Nor does the group admit one.
        expect(
          desktopStreamFenceDiagnostic(
            authorizedUnknown,
            stopUnconfirmed,
            origin,
            "tree_unconfirmed",
          ),
        ).toEqual({ ...group, desktop_stream_fence_origin: origin });
      },
    );

    it("never reads a cleanup sibling beside a malformed origin", () => {
      const cleanup = watched({ version: 1, failure: "tree_unconfirmed" });
      expect(
        parseNativeStreamFenceRejection(
          sibling(cleanup.proxy, {
            version: 2,
            origin: "owner_stop_requested",
          }),
        ),
      ).toEqual({ message: STOP_UNCONFIRMED, origin: null });
      expect(cleanup.reads.count).toBe(0);
    });

    const fail = () => {
      throw new Error("PRIVATE");
    };
    it.each<[string, () => unknown]>([
      ["an unlisted failure", () => ({ version: 1, failure: "PRIVATE" })],
      ["a numeric failure", () => ({ version: 1, failure: 1 })],
      [
        "an unsupported version",
        () => ({ version: 2, failure: "tree_unconfirmed" }),
      ],
      [
        "a string version",
        () => ({ version: "1", failure: "tree_unconfirmed" }),
      ],
      ["a missing version", () => ({ failure: "tree_unconfirmed" })],
      ["a missing failure", () => ({ version: 1 })],
      [
        "an extra field",
        () => ({ version: 1, failure: "tree_unconfirmed", pid: 4242 }),
      ],
      [
        "an extra symbol",
        () => ({ version: 1, failure: "tree_unconfirmed", [Symbol("x")]: 1 }),
      ],
      [
        "an inherited failure",
        () => Object.create({ version: 1, failure: "tree_unconfirmed" }),
      ],
      [
        "a null-prototype failure",
        () =>
          Object.assign(Object.create(null), {
            version: 1,
            failure: "tree_unconfirmed",
          }),
      ],
      [
        "a failure getter",
        () =>
          Object.defineProperty({ version: 1 }, "failure", {
            enumerable: true,
            get: fail,
          }),
      ],
      [
        "a throwing proxy",
        () =>
          new Proxy(
            { version: 1, failure: "tree_unconfirmed" },
            {
              getPrototypeOf: fail,
              ownKeys: fail,
              get: fail,
              getOwnPropertyDescriptor: fail,
            },
          ),
      ],
      ["a string", () => "tree_unconfirmed"],
      ["an array", () => [1, "tree_unconfirmed"]],
      ["null", () => null],
      ["undefined", () => undefined],
    ])(
      "keeps the exact message and stop origin beside %s",
      (_case, cleanup) => {
        const parsed = parseNativeStreamFenceRejection(sibling(cleanup()));
        expect(parsed).toEqual({
          message: STOP_UNCONFIRMED,
          origin: "owner_stop_requested",
        });
        expect(parsed).not.toHaveProperty("cleanupFailure");
      },
    );

    it("keeps the exact message and stop origin beside a cleanup accessor", () => {
      let gets = 0;
      const error = Object.defineProperty(
        rejection(stop),
        "streamFenceCleanup",
        {
          enumerable: true,
          get() {
            gets++;
            return { version: 1, failure: "tree_unconfirmed" };
          },
        },
      );
      expect(parseNativeStreamFenceRejection(error)).toEqual({
        message: STOP_UNCONFIRMED,
        origin: "owner_stop_requested",
      });
      expect(gets).toBe(0);
    });

    it.each<[string, () => unknown]>([
      [
        "a cleanup without an origin",
        () => ({
          message: STOP_UNCONFIRMED,
          streamFenceCleanup: { version: 1, failure: "tree_unconfirmed" },
        }),
      ],
      [
        "an extra field beside the sibling",
        () => ({
          ...sibling({ version: 1, failure: "tree_unconfirmed" }),
          pid: 4242,
        }),
      ],
      [
        "a sibling beside another message",
        () => ({
          ...sibling({ version: 1, failure: "tree_unconfirmed" }),
          message: PAGE_REPLACED,
        }),
      ],
      [
        "an inherited sibling",
        () =>
          Object.create(sibling({ version: 1, failure: "tree_unconfirmed" })),
      ],
    ])("reads nothing from %s", (_case, error) => {
      expect(parseNativeStreamFenceRejection(error())).toBeNull();
    });

    it("joins only a listed failure to a validated stop origin", () => {
      for (const failure of ["PRIVATE", 1, undefined, null])
        expect(
          desktopStreamFenceDiagnostic(
            authorizedUnknown,
            stopUnconfirmed,
            "owner_stop_requested",
            failure,
          ),
        ).toEqual(stopGroup);
      expect(
        desktopStreamFenceDiagnostic(
          authorizedUnknown,
          desktopInvocationUnknownDiagnostic(
            authorizedUnknown,
            "lifecycle_page_replaced",
          ),
          "owner_stop_requested",
          "tree_unconfirmed",
        ),
      ).toBeNull();
    });

    it("reads the cleanup pair only beside the stop origin on an acknowledged terminal", () => {
      const source = { ...stopGroup, ...cleanupGroup, message: "PRIVATE" };
      const read = readDesktopStreamFenceDiagnostic(
        source,
        authorizedUnknown,
        stopUnconfirmed,
        true,
      );
      expect(read).toEqual({ ...stopGroup, ...cleanupGroup });
      expect(Object.isFrozen(read)).toBe(true);
      // Without an acknowledged terminal, or beside another origin, the
      // cleanup keys are never read and the origin pair stays as before.
      for (const [base, acknowledged] of [
        [stopGroup, false],
        [stopGroup, undefined],
        [group, true],
      ] as const) {
        let reads = 0;
        const counted = new Proxy(
          { ...base, ...cleanupGroup },
          {
            getOwnPropertyDescriptor(target, key) {
              if (typeof key === "string" && key in cleanupGroup) reads++;
              return Reflect.getOwnPropertyDescriptor(target, key);
            },
          },
        );
        expect(
          readDesktopStreamFenceDiagnostic(
            counted,
            authorizedUnknown,
            stopUnconfirmed,
            acknowledged,
          ),
        ).toEqual(base);
        expect(reads).toBe(0);
      }
    });

    it("drops only an invalid or hostile cleanup pair", () => {
      let gets = 0;
      const accessor = { ...stopGroup } as Record<string, unknown>;
      for (const key of Object.keys(cleanupGroup))
        Object.defineProperty(accessor, key, {
          enumerable: true,
          get() {
            gets++;
            return cleanupGroup[key as keyof typeof cleanupGroup];
          },
        });
      for (const source of [
        { ...stopGroup },
        {
          ...stopGroup,
          ...cleanupGroup,
          desktop_stream_fence_cleanup_version: 2,
        },
        {
          ...stopGroup,
          ...cleanupGroup,
          desktop_stream_fence_cleanup_version: "1",
        },
        {
          ...stopGroup,
          ...cleanupGroup,
          desktop_stream_fence_cleanup_failure: "PRIVATE",
        },
        { ...stopGroup, desktop_stream_fence_cleanup_version: 1 },
        Object.assign(Object.create(cleanupGroup), stopGroup),
        accessor,
        new Proxy(
          { ...stopGroup, ...cleanupGroup },
          {
            get: fail,
            getOwnPropertyDescriptor(target, key) {
              if (typeof key === "string" && key in cleanupGroup) fail();
              return Reflect.getOwnPropertyDescriptor(target, key);
            },
          },
        ),
      ])
        expect(
          readDesktopStreamFenceDiagnostic(
            source,
            authorizedUnknown,
            stopUnconfirmed,
            true,
          ),
        ).toEqual(stopGroup);
      expect(gets).toBe(0);
    });

    describe("Windows taskkill receipt", () => {
      const treeCleanup = { version: 1, failure: "tree_unconfirmed" };
      const withTaskkill = (
        streamFenceWindowsTaskkill: unknown,
        streamFenceCleanup: unknown = treeCleanup,
      ) => ({
        ...sibling(streamFenceCleanup),
        streamFenceWindowsTaskkill,
      });
      const treeParsed = {
        message: STOP_UNCONFIRMED,
        origin: "owner_stop_requested",
        cleanupFailure: "tree_unconfirmed",
      };
      const taskkillGroup = {
        desktop_stream_fence_windows_taskkill_version: 1,
        desktop_stream_fence_windows_taskkill_outcome: "nonzero_exit",
        desktop_stream_fence_windows_taskkill_exit_code: 128,
      };

      // [native receipt, parsed receipt, analytics group]
      it.each<[unknown, unknown, Record<string, unknown>]>([
        [
          { version: 1, outcome: "nonzero_exit", exitCode: 128 },
          { outcome: "nonzero_exit", exitCode: 128 },
          taskkillGroup,
        ],
        [
          { version: 1, outcome: "nonzero_exit", exitCode: -2147483648 },
          { outcome: "nonzero_exit", exitCode: -2147483648 },
          {
            ...taskkillGroup,
            desktop_stream_fence_windows_taskkill_exit_code: -2147483648,
          },
        ],
        [
          { version: 1, outcome: "nonzero_exit", exitCode: 2147483647 },
          { outcome: "nonzero_exit", exitCode: 2147483647 },
          {
            ...taskkillGroup,
            desktop_stream_fence_windows_taskkill_exit_code: 2147483647,
          },
        ],
        [
          { version: 1, outcome: "nonzero_exit" },
          { outcome: "nonzero_exit" },
          {
            desktop_stream_fence_windows_taskkill_version: 1,
            desktop_stream_fence_windows_taskkill_outcome: "nonzero_exit",
          },
        ],
        [
          { version: 1, outcome: "output_error" },
          { outcome: "output_error" },
          {
            desktop_stream_fence_windows_taskkill_version: 1,
            desktop_stream_fence_windows_taskkill_outcome: "output_error",
          },
        ],
      ])(
        "joins %j only to a tree_unconfirmed stop",
        (receipt, windowsTaskkill, expected) => {
          const parsed = parseNativeStreamFenceRejection(withTaskkill(receipt));
          expect(parsed).toEqual({ ...treeParsed, windowsTaskkill });
          expect(Object.isFrozen(parsed!.windowsTaskkill)).toBe(true);
          const diagnostic = desktopStreamFenceDiagnostic(
            authorizedUnknown,
            stopUnconfirmed,
            parsed!.origin,
            parsed!.cleanupFailure,
            parsed!.windowsTaskkill,
          );
          expect(diagnostic).toEqual({
            ...stopGroup,
            ...cleanupGroup,
            ...expected,
          });
          expect(Object.isFrozen(diagnostic)).toBe(true);
          // Another cleanup failure never admits the group.
          expect(
            desktopStreamFenceDiagnostic(
              authorizedUnknown,
              stopUnconfirmed,
              "owner_stop_requested",
              "tree_and_leader_wait_failed",
              parsed!.windowsTaskkill,
            ),
          ).toEqual({
            ...stopGroup,
            desktop_stream_fence_cleanup_version: 1,
            desktop_stream_fence_cleanup_failure: "tree_and_leader_wait_failed",
          });
        },
      );

      const ok = { version: 1, outcome: "nonzero_exit", exitCode: 1 };
      it.each<[string, () => unknown]>([
        ["a zero code", () => ({ ...ok, exitCode: 0 })],
        ["a negative zero code", () => ({ ...ok, exitCode: -0 })],
        ["a fractional code", () => ({ ...ok, exitCode: 1.5 })],
        ["a code above i32", () => ({ ...ok, exitCode: 2147483648 })],
        ["a code below i32", () => ({ ...ok, exitCode: -2147483649 })],
        ["a string code", () => ({ ...ok, exitCode: "1" })],
        ["a NaN code", () => ({ ...ok, exitCode: Number.NaN })],
        ["a null code", () => ({ ...ok, exitCode: null })],
        [
          "a code beside output_error",
          () => ({ ...ok, outcome: "output_error" }),
        ],
        ["an unlisted outcome", () => ({ version: 1, outcome: "PRIVATE" })],
        ["an unsupported version", () => ({ ...ok, version: 2 })],
        ["a missing version", () => ({ outcome: "output_error" })],
        ["an extra field", () => ({ ...ok, pid: 4242 })],
        ["an extra symbol", () => ({ ...ok, [Symbol("x")]: 1 })],
        ["an inherited receipt", () => Object.create(ok)],
        [
          "a throwing proxy",
          () =>
            new Proxy(ok, {
              getPrototypeOf: fail,
              ownKeys: fail,
              get: fail,
              getOwnPropertyDescriptor: fail,
            }),
        ],
        ["a string", () => "nonzero_exit"],
        ["null", () => null],
      ])(
        "keeps the exact message, origin and cleanup beside %s",
        (_case, receipt) => {
          const parsed = parseNativeStreamFenceRejection(
            withTaskkill(receipt()),
          );
          expect(parsed).toEqual(treeParsed);
          expect(parsed).not.toHaveProperty("windowsTaskkill");
        },
      );

      it("never runs a code getter, even one returning a valid status", () => {
        let gets = 0;
        const receipt = Object.defineProperty(
          { version: 1, outcome: "nonzero_exit" },
          "exitCode",
          {
            enumerable: true,
            get() {
              gets++;
              return 1;
            },
          },
        );
        const parsed = parseNativeStreamFenceRejection(withTaskkill(receipt));
        expect(parsed).toEqual(treeParsed);
        expect(parsed).not.toHaveProperty("windowsTaskkill");
        expect(gets).toBe(0);
      });

      it("never reads a receipt beside another cleanup failure or without one", () => {
        const receipt = watched({ ...ok });
        expect(
          parseNativeStreamFenceRejection(
            withTaskkill(receipt.proxy, {
              version: 1,
              failure: "leader_wait_failed",
            }),
          ),
        ).toEqual({ ...treeParsed, cleanupFailure: "leader_wait_failed" });
        expect(
          parseNativeStreamFenceRejection(
            withTaskkill(receipt.proxy, { version: 2, failure: "PRIVATE" }),
          ),
        ).toEqual({
          message: STOP_UNCONFIRMED,
          origin: "owner_stop_requested",
        });
        expect(receipt.reads.count).toBe(0);
        // An unnegotiated shape is never unwrapped at all.
        expect(
          parseNativeStreamFenceRejection({
            ...rejection(stop),
            streamFenceWindowsTaskkill: ok,
          }),
        ).toBeNull();
        expect(
          parseNativeStreamFenceRejection({ ...withTaskkill(ok), pid: 4242 }),
        ).toBeNull();
      });

      it("reads the group only beside a tree_unconfirmed pair on an acknowledged terminal", () => {
        const source = {
          ...stopGroup,
          ...cleanupGroup,
          ...taskkillGroup,
          message: "PRIVATE",
        };
        const read = readDesktopStreamFenceDiagnostic(
          source,
          authorizedUnknown,
          stopUnconfirmed,
          true,
        );
        expect(read).toEqual({
          ...stopGroup,
          ...cleanupGroup,
          ...taskkillGroup,
        });
        expect(Object.isFrozen(read)).toBe(true);
        // Otherwise no taskkill key is read and the prior pairs stay as before.
        const otherCleanup = {
          ...stopGroup,
          desktop_stream_fence_cleanup_version: 1,
          desktop_stream_fence_cleanup_failure: "leader_wait_failed",
        };
        for (const [base, acknowledged] of [
          [otherCleanup, true],
          [stopGroup, false],
          [group, true],
        ] as const) {
          let reads = 0;
          const counted = new Proxy(
            { ...base, ...taskkillGroup },
            {
              getOwnPropertyDescriptor(target, key) {
                if (typeof key === "string" && key in taskkillGroup) reads++;
                return Reflect.getOwnPropertyDescriptor(target, key);
              },
            },
          );
          expect(
            readDesktopStreamFenceDiagnostic(
              counted,
              authorizedUnknown,
              stopUnconfirmed,
              acknowledged,
            ),
          ).toEqual(base);
          expect(reads).toBe(0);
        }
      });

      it("drops only an invalid or hostile taskkill group", () => {
        const pairs = { ...stopGroup, ...cleanupGroup };
        const outputError = {
          desktop_stream_fence_windows_taskkill_version: 1,
          desktop_stream_fence_windows_taskkill_outcome: "output_error",
        };
        let gets = 0;
        const accessor = Object.defineProperty(
          { ...pairs, ...taskkillGroup },
          "desktop_stream_fence_windows_taskkill_exit_code",
          {
            enumerable: true,
            get() {
              gets++;
              return 128;
            },
          },
        );
        const code = (value: unknown) => ({
          desktop_stream_fence_windows_taskkill_exit_code: value,
        });
        for (const source of [
          { ...pairs, ...outputError, ...code(1) },
          { ...pairs, ...taskkillGroup, ...code(0) },
          { ...pairs, ...taskkillGroup, ...code("128") },
          { ...pairs, ...taskkillGroup, ...code(undefined) },
          {
            ...pairs,
            ...taskkillGroup,
            desktop_stream_fence_windows_taskkill_version: 2,
          },
          {
            ...pairs,
            ...taskkillGroup,
            desktop_stream_fence_windows_taskkill_outcome: "PRIVATE",
          },
          { ...pairs, ...code(128) },
          accessor,
          new Proxy(
            { ...pairs, ...taskkillGroup },
            {
              getOwnPropertyDescriptor(target, key) {
                if (typeof key === "string" && key in taskkillGroup) fail();
                return Reflect.getOwnPropertyDescriptor(target, key);
              },
            },
          ),
        ])
          expect(
            readDesktopStreamFenceDiagnostic(
              source,
              authorizedUnknown,
              stopUnconfirmed,
              true,
            ),
          ).toEqual(pairs);
        expect(gets).toBe(0);
      });

      describe("root report", () => {
        const notFound = {
          version: 2,
          outcome: "nonzero_exit",
          exitCode: 128,
          rootReport: "requested_pid_not_found",
        };
        const rootPair = (report: string) => ({
          desktop_stream_fence_windows_taskkill_root_report_version: 1,
          desktop_stream_fence_windows_taskkill_root_report: report,
        });
        const code = (exitCode: number) => ({
          ...taskkillGroup,
          desktop_stream_fence_windows_taskkill_exit_code: exitCode,
        });

        // [native v2 receipt, parsed receipt, analytics groups]
        it.each<[unknown, unknown, Record<string, unknown>]>([
          [
            notFound,
            {
              outcome: "nonzero_exit",
              exitCode: 128,
              rootReport: "requested_pid_not_found",
            },
            { ...code(128), ...rootPair("requested_pid_not_found") },
          ],
          [
            { ...notFound, rootReport: "unclassified" },
            {
              outcome: "nonzero_exit",
              exitCode: 128,
              rootReport: "unclassified",
            },
            { ...code(128), ...rootPair("unclassified") },
          ],
          [
            { ...notFound, exitCode: 255, rootReport: "unclassified" },
            {
              outcome: "nonzero_exit",
              exitCode: 255,
              rootReport: "unclassified",
            },
            { ...code(255), ...rootPair("unclassified") },
          ],
        ])(
          "joins the v2 receipt %j beside the unchanged v1 group",
          (receipt, windowsTaskkill, expected) => {
            const parsed = parseNativeStreamFenceRejection(
              withTaskkill(receipt),
            );
            expect(parsed).toEqual({ ...treeParsed, windowsTaskkill });
            expect(Object.isFrozen(parsed!.windowsTaskkill)).toBe(true);
            const diagnostic = desktopStreamFenceDiagnostic(
              authorizedUnknown,
              stopUnconfirmed,
              parsed!.origin,
              parsed!.cleanupFailure,
              parsed!.windowsTaskkill,
            );
            expect(diagnostic).toEqual({
              ...stopGroup,
              ...cleanupGroup,
              ...expected,
            });
            // The property-bag reader keeps exactly the same groups.
            expect(
              readDesktopStreamFenceDiagnostic(
                { ...diagnostic, message: "PRIVATE" },
                authorizedUnknown,
                stopUnconfirmed,
                true,
              ),
            ).toEqual(diagnostic);
          },
        );

        it("keeps accepting an older native app's exact v1 receipt without a root report", () => {
          const parsed = parseNativeStreamFenceRejection(
            withTaskkill({
              version: 1,
              outcome: "nonzero_exit",
              exitCode: 128,
            }),
          );
          expect(parsed?.windowsTaskkill).toEqual({
            outcome: "nonzero_exit",
            exitCode: 128,
          });
          expect(
            desktopStreamFenceDiagnostic(
              authorizedUnknown,
              stopUnconfirmed,
              parsed!.origin,
              parsed!.cleanupFailure,
              parsed!.windowsTaskkill,
            ),
          ).toEqual({ ...stopGroup, ...cleanupGroup, ...taskkillGroup });
        });

        it.each<[string, () => unknown]>([
          ["not found beside exit 255", () => ({ ...notFound, exitCode: 255 })],
          ["not found beside exit 1", () => ({ ...notFound, exitCode: 1 })],
          [
            "not found beside a negative code",
            () => ({ ...notFound, exitCode: -128 }),
          ],
          [
            "an unlisted report",
            () => ({ ...notFound, rootReport: "PRIVATE" }),
          ],
          [
            "a raw taskkill line",
            () => ({
              ...notFound,
              rootReport: 'ERROR: The process "4242" not found.',
            }),
          ],
          ["a null report", () => ({ ...notFound, rootReport: null })],
          ["a boolean report", () => ({ ...notFound, rootReport: true })],
          ["a v1 receipt with a report", () => ({ ...notFound, version: 1 })],
          ["a v3 receipt", () => ({ ...notFound, version: 3 })],
          [
            "a v2 receipt without a report",
            () => ({ version: 2, outcome: "nonzero_exit", exitCode: 128 }),
          ],
          [
            "a v2 receipt without a code",
            () => ({
              version: 2,
              outcome: "nonzero_exit",
              rootReport: "unclassified",
            }),
          ],
          [
            "a v2 output_error",
            () => ({ ...notFound, outcome: "output_error" }),
          ],
          ["a v2 zero code", () => ({ ...notFound, exitCode: 0 })],
          ["a v2 string code", () => ({ ...notFound, exitCode: "128" })],
          ["an extra pid", () => ({ ...notFound, pid: 4242 })],
          ["an extra stderr", () => ({ ...notFound, stderr: "PRIVATE" })],
          [
            "an accessor report",
            () =>
              Object.defineProperty(
                { version: 2, outcome: "nonzero_exit", exitCode: 128 },
                "rootReport",
                { enumerable: true, get: fail },
              ),
          ],
          ["an inherited v2 receipt", () => Object.create(notFound)],
        ])("drops only the taskkill receipt for %s", (_case, receipt) => {
          const parsed = parseNativeStreamFenceRejection(
            withTaskkill(receipt()),
          );
          expect(parsed).toEqual(treeParsed);
          expect(parsed).not.toHaveProperty("windowsTaskkill");
        });

        it("never classifies an unchecked report beside another code or outcome", () => {
          const build = (windowsTaskkill: Record<string, unknown>) =>
            desktopStreamFenceDiagnostic(
              authorizedUnknown,
              stopUnconfirmed,
              "owner_stop_requested",
              "tree_unconfirmed",
              windowsTaskkill as never,
            );
          // A positive report beside another code drops alone; 255 is never
          // read as the tree's state.
          expect(
            build({
              outcome: "nonzero_exit",
              exitCode: 255,
              rootReport: "requested_pid_not_found",
            }),
          ).toEqual({ ...stopGroup, ...cleanupGroup, ...code(255) });
          expect(
            build({
              outcome: "nonzero_exit",
              exitCode: 128,
              rootReport: "PRIVATE",
            }),
          ).toEqual({ ...stopGroup, ...cleanupGroup, ...code(128) });
          // Without a code there is no root report at all.
          expect(
            build({ outcome: "nonzero_exit", rootReport: "unclassified" }),
          ).toEqual({
            ...stopGroup,
            ...cleanupGroup,
            desktop_stream_fence_windows_taskkill_version: 1,
            desktop_stream_fence_windows_taskkill_outcome: "nonzero_exit",
          });
          expect(
            build({ outcome: "output_error", rootReport: "unclassified" }),
          ).toEqual({
            ...stopGroup,
            ...cleanupGroup,
            desktop_stream_fence_windows_taskkill_version: 1,
            desktop_stream_fence_windows_taskkill_outcome: "output_error",
          });
        });

        it("reads the pair only beside a validated taskkill code", () => {
          const pairs = { ...stopGroup, ...cleanupGroup };
          const outputError = {
            desktop_stream_fence_windows_taskkill_version: 1,
            desktop_stream_fence_windows_taskkill_outcome: "output_error",
          };
          const root = rootPair("requested_pid_not_found");
          for (const [base, kept] of [
            [
              { ...pairs, ...outputError },
              { ...pairs, ...outputError },
            ],
            [
              {
                ...pairs,
                desktop_stream_fence_windows_taskkill_version: 1,
                desktop_stream_fence_windows_taskkill_outcome: "nonzero_exit",
              },
              {
                ...pairs,
                desktop_stream_fence_windows_taskkill_version: 1,
                desktop_stream_fence_windows_taskkill_outcome: "nonzero_exit",
              },
            ],
            [{ ...pairs, ...code(0) }, pairs],
            [pairs, pairs],
          ] as const) {
            let reads = 0;
            const counted = new Proxy(
              { ...base, ...root },
              {
                getOwnPropertyDescriptor(target, key) {
                  if (typeof key === "string" && key in root) reads++;
                  return Reflect.getOwnPropertyDescriptor(target, key);
                },
              },
            );
            expect(
              readDesktopStreamFenceDiagnostic(
                counted,
                authorizedUnknown,
                stopUnconfirmed,
                true,
              ),
            ).toEqual(kept);
            expect(reads).toBe(0);
          }
        });

        it("drops only an invalid or hostile root report pair", () => {
          const kept = { ...stopGroup, ...cleanupGroup, ...code(255) };
          let gets = 0;
          const accessor = Object.defineProperty(
            { ...kept, ...rootPair("unclassified") },
            "desktop_stream_fence_windows_taskkill_root_report",
            {
              enumerable: true,
              get() {
                gets++;
                return "unclassified";
              },
            },
          );
          for (const source of [
            { ...kept, ...rootPair("requested_pid_not_found") },
            { ...kept, ...rootPair("PRIVATE") },
            {
              ...kept,
              ...rootPair("unclassified"),
              desktop_stream_fence_windows_taskkill_root_report_version: 2,
            },
            {
              ...kept,
              desktop_stream_fence_windows_taskkill_root_report: "unclassified",
            },
            {
              ...kept,
              desktop_stream_fence_windows_taskkill_root_report_version: 1,
            },
            accessor,
            new Proxy(
              { ...kept, ...rootPair("unclassified") },
              {
                getOwnPropertyDescriptor(target, key) {
                  if (
                    typeof key === "string" &&
                    key.startsWith(
                      "desktop_stream_fence_windows_taskkill_root_report",
                    )
                  )
                    fail();
                  return Reflect.getOwnPropertyDescriptor(target, key);
                },
              },
            ),
          ])
            expect(
              readDesktopStreamFenceDiagnostic(
                source,
                authorizedUnknown,
                stopUnconfirmed,
                true,
              ),
            ).toEqual(kept);
          expect(gets).toBe(0);
        });
      });
    });
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

describe("spawn OS code hint group", () => {
  const nativeAdapters = [
    "authorized_native",
    "compatibility_native",
    "published_legacy_native",
  ];
  const spawnFailed = desktopInvocationRejectionDiagnostic(
    "spawn_failed",
    "authorized_native",
  );
  const group = {
    desktop_invocation_spawn_hint_version: 1,
    desktop_invocation_spawn_os_code_hint: "code_267",
  };

  it("refines spawn_failed from every native command set", () => {
    for (const adapter of nativeAdapters)
      for (const hint of ["code_2", "unrecognized"]) {
        const built = desktopInvocationSpawnHintDiagnostic(
          desktopInvocationRejectionDiagnostic("spawn_failed", adapter),
          hint,
        );
        expect(built).toEqual({
          desktop_invocation_spawn_hint_version: 1,
          desktop_invocation_spawn_os_code_hint: hint,
        });
        expect(Object.isFrozen(built)).toBe(true);
      }
  });

  it.each<[string, unknown, unknown]>([
    ["no class", null, "code_2"],
    [
      "an admission class",
      desktopInvocationRejectionDiagnostic(
        "execution_admission",
        "authorized_native",
      ),
      "code_2",
    ],
    [
      "an unknown class",
      desktopInvocationRejectionDiagnostic("unknown", "authorized_native"),
      "unrecognized",
    ],
    [
      "an unselected class",
      desktopInvocationRejectionDiagnostic("unknown", "not_selected"),
      "unrecognized",
    ],
    // A forged spawn class without a selected command set never qualifies.
    [
      "an unvalidated unselected spawn class",
      {
        desktop_invocation_rejection_version: 1,
        desktop_invocation_rejection_reason: "spawn_failed",
        desktop_invocation_rejection_adapter: "not_selected",
      },
      "code_2",
    ],
    ["no hint", spawnFailed, null],
    ["an arbitrary code", spawnFailed, "code_4"],
    ["a numeric code", spawnFailed, 2],
    ["a raw suffix", spawnFailed, "(os error 2)"],
    ["a private value", spawnFailed, "PRIVATE"],
  ])("builds nothing for %s", (_case, rejection, hint) => {
    expect(
      desktopInvocationSpawnHintDiagnostic(
        rejection as DesktopInvocationRejectionDiagnostic | null,
        hint,
      ),
    ).toBeNull();
  });

  it("reads only the complete group's data values", () => {
    const read = readDesktopInvocationSpawnHintDiagnostic(
      { ...group, message: "PRIVATE", cwd: "PRIVATE" },
      spawnFailed,
    );
    expect(read).toEqual(group);
    expect(Object.isFrozen(read)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["no source", undefined],
    ["a string source", "PRIVATE"],
    ["an empty bag", {}],
    [
      "a missing hint",
      { ...group, desktop_invocation_spawn_os_code_hint: undefined },
    ],
    [
      "a missing version",
      { ...group, desktop_invocation_spawn_hint_version: undefined },
    ],
    [
      "a string version",
      { ...group, desktop_invocation_spawn_hint_version: "1" },
    ],
    [
      "an unsupported version",
      { ...group, desktop_invocation_spawn_hint_version: 2 },
    ],
    [
      "an unlisted code",
      { ...group, desktop_invocation_spawn_os_code_hint: "code_1" },
    ],
    [
      "a raw suffix",
      { ...group, desktop_invocation_spawn_os_code_hint: " (os error 267)" },
    ],
    [
      "an inherited group",
      Object.create(group as object) as Record<string, unknown>,
    ],
  ])("reads nothing for %s", (_case, source) => {
    expect(
      readDesktopInvocationSpawnHintDiagnostic(source, spawnFailed),
    ).toBeNull();
  });

  it("never reads a source without a validated selected spawn_failed class", () => {
    const fail = () => {
      throw new Error("PRIVATE");
    };
    // Any descriptor read would throw; the gate must come first.
    const hostile = new Proxy(
      { ...group },
      { get: fail, getOwnPropertyDescriptor: fail, ownKeys: fail },
    );
    let reads = 0;
    const counted = new Proxy(
      { ...group },
      {
        getOwnPropertyDescriptor(target, key) {
          reads++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    for (const other of [
      null,
      desktopInvocationRejectionDiagnostic(
        "execution_admission",
        "authorized_native",
      ),
      desktopInvocationRejectionDiagnostic("unknown", "not_selected"),
    ]) {
      expect(
        readDesktopInvocationSpawnHintDiagnostic(hostile, other),
      ).toBeNull();
      expect(
        readDesktopInvocationSpawnHintDiagnostic(counted, other),
      ).toBeNull();
    }
    expect(reads).toBe(0);
  });

  it("never runs an accessor and survives a throwing proxy", () => {
    let reads = 0;
    const accessor = { ...group };
    Object.defineProperty(accessor, "desktop_invocation_spawn_os_code_hint", {
      enumerable: true,
      get() {
        reads++;
        return "code_2";
      },
    });
    expect(
      readDesktopInvocationSpawnHintDiagnostic(accessor, spawnFailed),
    ).toBeNull();
    expect(reads).toBe(0);
    const fail = () => {
      throw new Error("PRIVATE");
    };
    expect(
      readDesktopInvocationSpawnHintDiagnostic(
        new Proxy(
          { ...group },
          { get: fail, getOwnPropertyDescriptor: fail, ownKeys: fail },
        ),
        spawnFailed,
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
