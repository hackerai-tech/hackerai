import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessLocalWorkspaceFiles } from "../local-workspace-files";
import { workspaceRequest } from "../workspace-files";
const query = jest.fn();
const run = jest.fn();
const close = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query }),
}));
jest.mock("@/lib/ai/tools/utils/centrifugo-sandbox", () => ({
  CentrifugoSandbox: jest
    .fn()
    .mockImplementation(() => ({ commands: { run }, close })),
}));
const input = (extra = {}) =>
  workspaceRequest.parse({ chatId: "chat", action: "list", ...extra });
beforeEach(() => {
  jest.clearAllMocks();
  process.env.CONVEX_SERVICE_ROLE_KEY = "test";
  process.env.CENTRIFUGO_WS_URL = "wss://test.invalid";
  process.env.CENTRIFUGO_TOKEN_SECRET = "test";
  query.mockResolvedValueOnce("environment:machine").mockResolvedValueOnce([
    {
      connectionId: "session",
      environmentId: "machine",
      name: "Test Mac",
      osInfo: { platform: "darwin" },
    },
  ]);
  run.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({
      root: "/home/test",
      entries: [],
      total: 0,
      nextOffset: null,
    }),
  });
});
it("targets the owner's selected connection and returns its root", async () => {
  expect(
    await accessLocalWorkspaceFiles("owner", "environment:machine", input()),
  ).toMatchObject({
    sandboxId: "session",
    root: "/home/test",
    environmentLabel: "Test Mac",
  });
  expect(query.mock.calls[1][1]).toMatchObject({ userId: "owner" });
  expect(close).toHaveBeenCalled();
});
it("rejects a pinned session change without issuing any command", async () => {
  await expect(
    accessLocalWorkspaceFiles(
      "owner",
      "environment:machine",
      input({ sandboxId: "old-session" }),
    ),
  ).rejects.toMatchObject({ code: "workspace_changed" });
  expect(run).not.toHaveBeenCalled();
});
it("never chooses another local computer when the selected one is absent", async () => {
  query
    .mockReset()
    .mockResolvedValueOnce("environment:missing")
    .mockResolvedValueOnce([
      { connectionId: "session", environmentId: "other", name: "Other" },
    ]);
  expect(
    await accessLocalWorkspaceFiles("owner", "environment:missing", input()),
  ).toMatchObject({ state: "disconnected" });
  expect(run).not.toHaveBeenCalled();
});
it("releases the relay on failures and preserves a file-change error", async () => {
  run.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({ error: "file_changed" }),
  });
  await expect(
    accessLocalWorkspaceFiles("owner", "environment:machine", input()),
  ).rejects.toMatchObject({ code: "file_changed" });
  expect(close).toHaveBeenCalled();
});

it.each(["status", "resume"])(
  "returns a real root listing for Local %s without a path",
  async (action) => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "local-workspace-resume-")),
    );
    try {
      writeFileSync(join(root, "report.txt"), "fixture");
      run.mockImplementationOnce(async (command: string) => ({
        exitCode: 0,
        stdout: execFileSync("sh", ["-c", command], {
          encoding: "utf8",
          cwd: root,
        }),
      }));
      const result = await accessLocalWorkspaceFiles(
        "owner",
        "environment:machine",
        input({ action, sandboxId: "session" }),
        root,
      );
      expect(result).toMatchObject({
        state: "running",
        sandboxId: "session",
        root,
        entries: [{ name: "report.txt", kind: "file", size: 7 }],
      });
      expect(close).toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
