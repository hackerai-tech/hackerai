import { captureBrowserFrame, resizeBrowserViewport } from "../server";
import type { Sandbox } from "@e2b/code-interpreter";

jest.mock("server-only", () => ({}));
jest.mock("@e2b/code-interpreter", () => ({ Sandbox: {} }));
jest.mock("@/lib/ai/tools/utils/e2b-cluster", () => ({
  getE2BClusterRouting: jest.fn(),
}));
jest.mock("@/lib/ai/tools/utils/sandbox-command-options", () => ({
  buildSandboxCommandOptions: () => ({ user: "root" }),
}));

const location = {
  userId: "owner",
  sandboxId: "sandbox",
  triggerRegion: null,
  directory: "/dev/shm/hackerai-browser-0123456789abcdef01234567",
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const cached = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const fresh = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);

function fixture(screenshotExitCode = 0, viewportExitCode = 0) {
  const sandbox = {
    commands: {
      run: jest.fn(async (command: string) => {
        if (command.includes('"action":"stream_status"'))
          return {
            exitCode: 0,
            stdout: JSON.stringify({ data: { port: 1234 } }),
          };
        if (command.includes('"action":"screenshot"'))
          return { exitCode: screenshotExitCode, stdout: "" };
        if (command.includes('"action":"viewport"'))
          return { exitCode: viewportExitCode, stdout: "" };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            data: cached.toString("base64"),
            width: 800,
            height: 600,
            capturedAt: 0,
          }),
        };
      }),
    },
    files: {
      getInfo: jest.fn(async () => ({ size: fresh.length })),
      read: jest.fn(async () => fresh),
      remove: jest.fn(async () => undefined),
    },
  };
  return sandbox;
}

it("replaces an undated cached preview with a newly captured image for handoff", async () => {
  const sandbox = fixture();
  const before = Date.now();
  const result = await captureBrowserFrame(
    sandbox as unknown as Sandbox,
    location,
    "default",
    true,
  );
  expect(result.image).toBe(
    `data:image/jpeg;base64,${fresh.toString("base64")}`,
  );
  expect(result.capturedAt).toBeGreaterThanOrEqual(before);
  expect(sandbox.commands.run).toHaveBeenCalledWith(
    expect.stringContaining('"action":"screenshot"'),
    expect.objectContaining({ user: "root" }),
  );
  expect(sandbox.files.remove).toHaveBeenCalledWith(
    expect.stringMatching(/\/preview-[a-f0-9]{32}\.jpg$/),
    expect.anything(),
  );
});

it("fails closed and removes the temporary file when fresh capture fails", async () => {
  const sandbox = fixture(1);
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      true,
    ),
  ).rejects.toThrow("Browser preview disconnected");
  expect(sandbox.files.read).not.toHaveBeenCalled();
  expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
});

it("keeps cached-frame age unknown for ordinary viewing", async () => {
  const sandbox = fixture();
  const result = await captureBrowserFrame(
    sandbox as unknown as Sandbox,
    location,
    "default",
  );
  expect(result.capturedAt).toBe(0);
  expect(result.image).toBe(
    `data:image/jpeg;base64,${cached.toString("base64")}`,
  );
  expect(sandbox.files.read).not.toHaveBeenCalled();
});

it("resizes only the bound browser session and returns a fresh frame", async () => {
  const sandbox = fixture();
  const result = await resizeBrowserViewport(
    sandbox as unknown as Sandbox,
    location,
    "child-one",
    390,
    844,
  );
  expect(sandbox.commands.run).toHaveBeenCalledWith(
    expect.stringContaining(
      '"action":"viewport","width":390,"height":844,"deviceScaleFactor":1',
    ),
    expect.objectContaining({ user: "root" }),
  );
  expect(result.image).toBe(
    `data:image/jpeg;base64,${fresh.toString("base64")}`,
  );
  expect(result.browserSessionName).toBe("child-one");
  expect(result.width).toBe(390);
  expect(result.height).toBe(844);
});

it("does not return a new image or coordinate space when resizing fails", async () => {
  const sandbox = fixture(0, 1);
  await expect(
    resizeBrowserViewport(
      sandbox as unknown as Sandbox,
      location,
      "child-one",
      390,
      844,
    ),
  ).rejects.toThrow("Browser preview disconnected");
  expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
  expect(sandbox.files.read).not.toHaveBeenCalled();
});

it("rejects unbounded viewport dimensions before executing a command", async () => {
  const sandbox = fixture();
  await expect(
    resizeBrowserViewport(
      sandbox as unknown as Sandbox,
      location,
      "default",
      99999,
      844,
    ),
  ).rejects.toThrow("Invalid browser viewport");
  expect(sandbox.commands.run).not.toHaveBeenCalled();
});
