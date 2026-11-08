jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery }),
}));
jest.mock("@/lib/ai/tools/utils/hybrid-sandbox-manager", () => ({
  queryLiveSandboxConnectionIds: (...args: unknown[]) => mockPresence(...args),
}));
import {
  findScheduledConnection,
  watchScheduledConnection,
} from "../local-execution";
const mockQuery = jest.fn(),
  mockPresence = jest.fn();
const environmentId = "12345678-1234-4123-8123-123456789abc";
const connection = {
  environmentId,
  connectionId: "session",
  name: "Lab",
  capabilities: { commands: true },
  isDesktop: false,
};
beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue([connection]);
});
afterEach(() => {
  jest.useRealTimers();
});
it("requires live presence and cannot select another computer or another user's session", async () => {
  mockPresence.mockResolvedValue({
    reliable: true,
    onlineConnectionIds: new Set(["other-session"]),
  });
  expect(
    await findScheduledConnection("owner", `environment:${environmentId}`),
  ).toBeNull();
  expect(mockQuery).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ userId: "owner" }),
  );
  mockPresence.mockResolvedValue({
    reliable: true,
    onlineConnectionIds: new Set(["session"]),
  });
  expect(
    await findScheduledConnection("owner", `environment:${environmentId}`),
  ).toEqual(connection);
  expect(
    await findScheduledConnection(
      "owner",
      `desktop-environment:${environmentId}`,
    ),
  ).toBeNull();
});
it("fails closed when live relay presence cannot be established", async () => {
  mockPresence.mockResolvedValue({
    reliable: false,
    onlineConnectionIds: new Set(["session"]),
  });
  await expect(
    findScheduledConnection("owner", `environment:${environmentId}`),
  ).rejects.toThrow("verify");
});
it("stops once on loss of the pinned session and never resumes when a replacement appears", async () => {
  jest.useFakeTimers();
  const onLost = jest.fn();
  mockPresence
    .mockResolvedValueOnce({
      reliable: true,
      onlineConnectionIds: new Set(["session"]),
    })
    .mockResolvedValue({
      reliable: true,
      onlineConnectionIds: new Set(["replacement"]),
    });
  const dispose = watchScheduledConnection({
    userId: "owner",
    connectionId: "session",
    onLost,
  });
  await jest.advanceTimersByTimeAsync(10000);
  expect(onLost).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(20000);
  expect(mockPresence).toHaveBeenCalledTimes(2);
  dispose();
});
it("does not report connection loss after the run has already finished", async () => {
  jest.useFakeTimers();
  let resolve!: (result: unknown) => void;
  mockPresence.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const onLost = jest.fn();
  const dispose = watchScheduledConnection({
    userId: "owner",
    connectionId: "session",
    onLost,
  });
  await jest.advanceTimersByTimeAsync(5000);
  dispose();
  resolve({ reliable: false, onlineConnectionIds: new Set() });
  await Promise.resolve();
  expect(onLost).not.toHaveBeenCalled();
});
