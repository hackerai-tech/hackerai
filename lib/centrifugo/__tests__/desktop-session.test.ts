/** @jest-environment node */
import {
  DESKTOP_SESSION_CHALLENGE,
  DESKTOP_SESSION_PROOF,
  MAX_RECONCILED_COMMANDS,
  answerDesktopSessionChallenge,
  parseDesktopSessionChallenge,
  parseDesktopSessionProof,
} from "../desktop-session";

const NONCE = "b".repeat(32);
const LAUNCH = "c".repeat(32);
const startup = { launchId: LAUNCH, pageGeneration: 4 };
const challenge = (commandIds: unknown = ["running", "finished"]) =>
  parseDesktopSessionChallenge({
    type: DESKTOP_SESSION_CHALLENGE,
    nonce: NONCE,
    targetConnectionId: "conn-1",
    commandIds,
  })!;
const host = (lifecycle: unknown) => ({
  connectionId: "conn-1",
  startup,
  readNativeOsInfo: jest.fn(async () => ({ platform: "darwin", lifecycle })),
  retainsOutput: (id: string) => id === "running",
});

afterEach(() => jest.useRealTimers());

describe("the host's answer", () => {
  test("proves the same launch and page from a fresh native read, naming only retained output", async () => {
    const answering = host({ ...startup, previousExit: "clean" });
    await expect(
      answerDesktopSessionChallenge(challenge(), answering),
    ).resolves.toEqual({
      type: DESKTOP_SESSION_PROOF,
      nonce: NONCE,
      connectionId: "conn-1",
      launchId: LAUNCH,
      pageGeneration: 4,
      retainedCommandIds: ["running"],
    });
    expect(answering.readNativeOsInfo).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["a later page", { ...startup, pageGeneration: 5 }],
    ["another launch", { ...startup, launchId: "d".repeat(32) }],
    ["no lifecycle", undefined],
    ["a malformed launch", { ...startup, launchId: "/home/user" }],
    ["a fractional page", { ...startup, pageGeneration: 4.5 }],
  ])("cannot vouch for earlier commands with %s", async (_name, lifecycle) => {
    await expect(
      answerDesktopSessionChallenge(challenge(), host(lifecycle)),
    ).resolves.toEqual({
      type: DESKTOP_SESSION_PROOF,
      nonce: NONCE,
      connectionId: "conn-1",
      unavailable: true,
    });
  });

  test("a binary without startup identity answers unavailable without a native read", async () => {
    const answering = { ...host(startup), startup: undefined };
    await expect(
      answerDesktopSessionChallenge(challenge(), answering),
    ).resolves.toMatchObject({ unavailable: true });
    expect(answering.readNativeOsInfo).not.toHaveBeenCalled();
  });

  test("a failed or hung native read answers nothing, leaving the observer's window in charge", async () => {
    const failing = host(startup);
    failing.readNativeOsInfo.mockRejectedValueOnce(
      new Error("Command get_desktop_os_info not found"),
    );
    await expect(
      answerDesktopSessionChallenge(challenge(), failing),
    ).resolves.toBeUndefined();

    jest.useFakeTimers();
    const hung = host(startup);
    hung.readNativeOsInfo.mockReturnValueOnce(new Promise(() => {}));
    const answer = answerDesktopSessionChallenge(challenge(), hung);
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(answer).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("never answers a challenge for another connection", async () => {
    const answering = { ...host(startup), connectionId: "conn-2" };
    await expect(
      answerDesktopSessionChallenge(challenge(), answering),
    ).resolves.toBeUndefined();
    expect(answering.readNativeOsInfo).not.toHaveBeenCalled();
  });
});

describe("message validation", () => {
  test.each([
    ["a short nonce", { nonce: "b".repeat(31) }],
    ["a channel-syntax target", { targetConnectionId: "conn#other" }],
    ["a non-array list", { commandIds: "running" }],
    ["an invalid command", { commandIds: ["a:b"] }],
    [
      "too many commands",
      {
        commandIds: Array.from(
          { length: MAX_RECONCILED_COMMANDS + 1 },
          (_, index) => `c${index}`,
        ),
      },
    ],
  ])("rejects a challenge with %s", (_name, override) => {
    expect(
      parseDesktopSessionChallenge({
        type: DESKTOP_SESSION_CHALLENGE,
        nonce: NONCE,
        targetConnectionId: "conn-1",
        commandIds: [],
        ...override,
      }),
    ).toBeUndefined();
  });

  const proof = {
    type: DESKTOP_SESSION_PROOF,
    nonce: NONCE,
    connectionId: "conn-1",
    launchId: LAUNCH,
    pageGeneration: 4,
    retainedCommandIds: ["running"],
  };
  test.each([
    ["a missing page", { pageGeneration: undefined }],
    ["a negative page", { pageGeneration: -1 }],
    ["an uppercase launch", { launchId: "C".repeat(32) }],
    ["no retained list", { retainedCommandIds: undefined }],
    ["an invalid retained command", { retainedCommandIds: ["x y"] }],
  ])("rejects a proof with %s", (_name, override) => {
    expect(parseDesktopSessionProof({ ...proof, ...override })).toBeUndefined();
  });

  test("keeps only the fixed proof fields", () => {
    expect(
      parseDesktopSessionProof({ ...proof, url: "https://target.example/" }),
    ).toEqual(proof);
    expect(
      parseDesktopSessionProof({
        type: DESKTOP_SESSION_PROOF,
        nonce: NONCE,
        connectionId: "conn-1",
        unavailable: true,
        launchId: LAUNCH,
      }),
    ).toEqual({
      type: DESKTOP_SESSION_PROOF,
      nonce: NONCE,
      connectionId: "conn-1",
      unavailable: true,
    });
  });
});
