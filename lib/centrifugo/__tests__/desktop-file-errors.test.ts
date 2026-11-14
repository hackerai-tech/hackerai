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
