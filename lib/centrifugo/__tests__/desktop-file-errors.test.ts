import { readDesktopFileReceiverDiagnostic } from "../desktop-file-errors";

const valid = {
  version: 1,
  stage: "loopback_response",
  adapter: "legacy_loopback",
};

describe("readDesktopFileReceiverDiagnostic", () => {
  it("returns a fresh closed copy without unknown properties", () => {
    const receiverDiagnostic = { ...valid, detail: "PRIVATE_PATH" };
    const fileError = { message: "PRIVATE_MESSAGE", receiverDiagnostic };

    const parsed = readDesktopFileReceiverDiagnostic(fileError);

    expect(parsed).toEqual(valid);
    expect(parsed).not.toBe(receiverDiagnostic);
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
  });

  it.each([
    ["module_load", "compatibility_native"],
    ["native_invoke", "authorized_native"],
    ["stat_reply_validation", "published_legacy_native"],
    ["reply_publication", "legacy_loopback"],
  ])("accepts %s from %s", (stage, adapter) => {
    expect(
      readDesktopFileReceiverDiagnostic({
        receiverDiagnostic: { version: 1, stage, adapter },
      }),
    ).toEqual({ version: 1, stage, adapter });
  });

  it.each([
    ["no container", null],
    ["an array container", [valid]],
    ["a missing diagnostic", {}],
    ["a null diagnostic", { receiverDiagnostic: null }],
    ["an array diagnostic", { receiverDiagnostic: [1, "native_invoke"] }],
    ["a string version", { receiverDiagnostic: { ...valid, version: "1" } }],
    ["a future version", { receiverDiagnostic: { ...valid, version: 2 } }],
    [
      "an arbitrary stage",
      { receiverDiagnostic: { ...valid, stage: "PRIVATE_PATH" } },
    ],
    [
      "an arbitrary adapter",
      { receiverDiagnostic: { ...valid, adapter: "toString" } },
    ],
    [
      "a native stage on the loopback adapter",
      { receiverDiagnostic: { ...valid, stage: "native_invoke" } },
    ],
    [
      "a loopback stage on a native adapter",
      { receiverDiagnostic: { ...valid, adapter: "authorized_native" } },
    ],
    [
      "an inherited diagnostic",
      Object.create({ receiverDiagnostic: valid }) as object,
    ],
    [
      "inherited fields",
      { receiverDiagnostic: Object.create(valid) as object },
    ],
  ])("rejects %s", (_name, fileError) => {
    expect(readDesktopFileReceiverDiagnostic(fileError)).toBeUndefined();
  });

  it.each([
    "resolved_published_legacy",
    "resolved_other",
    "timeout",
    "rejected",
    "invalid",
    "unobserved",
  ])("keeps the closed native version lookup %s", (nativeVersionLookup) => {
    expect(
      readDesktopFileReceiverDiagnostic({
        receiverDiagnostic: { ...valid, nativeVersionLookup },
      }),
    ).toEqual({ ...valid, nativeVersionLookup });
  });

  it.each([
    ["a raw native version", "0.0.72"],
    ["an arbitrary string", "PRIVATE_PATH"],
    ["a prototype key", "toString"],
    ["a non-string", 1],
    ["null", null],
    ["an object", { outcome: "timeout" }],
  ])(
    "omits %s lookup but keeps the valid stage and adapter",
    (_name, nativeVersionLookup) => {
      const parsed = readDesktopFileReceiverDiagnostic({
        receiverDiagnostic: { ...valid, nativeVersionLookup },
      });

      expect(parsed).toEqual(valid);
      expect(parsed).not.toHaveProperty("nativeVersionLookup");
      expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
    },
  );

  it("never reads an accessor or inherited lookup and keeps the stage", () => {
    const getter = jest.fn(() => "timeout");
    const accessor = { ...valid };
    Object.defineProperty(accessor, "nativeVersionLookup", {
      enumerable: true,
      get: getter,
    });
    const inherited = Object.assign(
      Object.create({ nativeVersionLookup: "timeout" }) as object,
      valid,
    );

    expect(
      readDesktopFileReceiverDiagnostic({ receiverDiagnostic: accessor }),
    ).toEqual(valid);
    expect(
      readDesktopFileReceiverDiagnostic({ receiverDiagnostic: inherited }),
    ).toEqual(valid);
    expect(getter).not.toHaveBeenCalled();
  });

  describe("late native version lookup", () => {
    const withoutLookup = {
      version: 1,
      stage: "native_invoke",
      adapter: "authorized_native",
    };
    const timedOutAuthorized = {
      ...withoutLookup,
      nativeVersionLookup: "timeout",
    };

    it.each([
      "resolved_published_legacy",
      "resolved_other",
      "invalid",
      "rejected",
      "pending",
      "unresolved",
    ])("keeps %s beside a timed-out authorized invoke", (late) => {
      expect(
        readDesktopFileReceiverDiagnostic({
          receiverDiagnostic: {
            ...timedOutAuthorized,
            nativeVersionLateLookup: late,
          },
        }),
      ).toEqual({ ...timedOutAuthorized, nativeVersionLateLookup: late });
    });

    it.each<[string, Record<string, unknown>, unknown]>([
      ["a raw native version", timedOutAuthorized, "0.0.71"],
      ["an arbitrary string", timedOutAuthorized, "PRIVATE_PATH"],
      ["an initial-lookup-only value", timedOutAuthorized, "timeout"],
      ["a prototype key", timedOutAuthorized, "toString"],
      ["a non-string", timedOutAuthorized, 1],
      [
        "a lookup that met its deadline",
        { ...timedOutAuthorized, nativeVersionLookup: "resolved_other" },
        "resolved_published_legacy",
      ],
      ["an old sender's group", withoutLookup, "resolved_published_legacy"],
      [
        "an unusable initial lookup",
        { ...timedOutAuthorized, nativeVersionLookup: "0.0.71" },
        "resolved_published_legacy",
      ],
      [
        "the published legacy adapter",
        { ...timedOutAuthorized, adapter: "published_legacy_native" },
        "resolved_published_legacy",
      ],
      [
        "the compatibility adapter",
        { ...timedOutAuthorized, adapter: "compatibility_native" },
        "resolved_published_legacy",
      ],
      [
        "a later stage",
        { ...timedOutAuthorized, stage: "stat_reply_validation" },
        "resolved_published_legacy",
      ],
    ])("omits it from %s and keeps the rest", (_name, diagnostic, late) => {
      const parsed = readDesktopFileReceiverDiagnostic({
        receiverDiagnostic: { ...diagnostic, nativeVersionLateLookup: late },
      });

      expect(parsed).toBeDefined();
      expect(parsed).toEqual(
        readDesktopFileReceiverDiagnostic({ receiverDiagnostic: diagnostic }),
      );
      expect(parsed).not.toHaveProperty("nativeVersionLateLookup");
      expect(JSON.stringify(parsed)).not.toMatch(/PRIVATE|0\.0\.71/);
    });

    it("never reads an accessor or inherited late lookup", () => {
      const getter = jest.fn(() => "resolved_published_legacy");
      const accessor = { ...timedOutAuthorized };
      Object.defineProperty(accessor, "nativeVersionLateLookup", {
        enumerable: true,
        get: getter,
      });
      const inherited = Object.assign(
        Object.create({
          nativeVersionLateLookup: "resolved_published_legacy",
        }) as object,
        timedOutAuthorized,
      );

      expect(
        readDesktopFileReceiverDiagnostic({ receiverDiagnostic: accessor }),
      ).toEqual(timedOutAuthorized);
      expect(
        readDesktopFileReceiverDiagnostic({ receiverDiagnostic: inherited }),
      ).toEqual(timedOutAuthorized);
      expect(getter).not.toHaveBeenCalled();
    });
  });

  it("still rejects an invalid group even with a valid lookup", () => {
    expect(
      readDesktopFileReceiverDiagnostic({
        receiverDiagnostic: {
          ...valid,
          adapter: "authorized_native",
          nativeVersionLookup: "resolved_other",
        },
      }),
    ).toBeUndefined();
  });

  it("never invokes accessors on the message or diagnostic", () => {
    const getter = jest.fn(() => valid.stage);
    const diagnostic = { version: 1, adapter: valid.adapter };
    Object.defineProperty(diagnostic, "stage", { get: getter });
    const message = {};
    Object.defineProperty(message, "receiverDiagnostic", { get: getter });

    expect(
      readDesktopFileReceiverDiagnostic({ receiverDiagnostic: diagnostic }),
    ).toBeUndefined();
    expect(readDesktopFileReceiverDiagnostic(message)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });

  it("contains hostile proxies instead of throwing", () => {
    const throwing = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("PRIVATE_TRAP");
        },
      },
    );
    const revocable = Proxy.revocable({ receiverDiagnostic: valid }, {});
    revocable.revoke();

    expect(readDesktopFileReceiverDiagnostic(throwing)).toBeUndefined();
    expect(
      readDesktopFileReceiverDiagnostic({ receiverDiagnostic: throwing }),
    ).toBeUndefined();
    expect(readDesktopFileReceiverDiagnostic(revocable.proxy)).toBeUndefined();
  });
});
