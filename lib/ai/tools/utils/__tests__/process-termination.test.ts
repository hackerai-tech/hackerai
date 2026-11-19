/** @jest-environment node */
import { CommandExitError } from "@e2b/code-interpreter";
import type { AnySandbox } from "@/types";
import { verifyProcessTerminated } from "../process-termination";

const exited = (exitCode: number, stderr = "") =>
  new CommandExitError({
    exitCode,
    stdout: "",
    stderr,
    error: "command exited",
  });

function fixture() {
  const run = jest.fn();
  return { run, sandbox: { commands: { run } } as unknown as AnySandbox };
}

beforeEach(() => jest.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

it.each([
  new Error("connection unavailable"),
  exited(127, "ps: not found"),
  exited(1, "ps: permission denied"),
])(
  "does not confirm cleanup when the process query fails: %s",
  async (error) => {
    const { run, sandbox } = fixture();
    run.mockRejectedValue(error);
    await expect(verifyProcessTerminated(sandbox, 4321, 2, 0)).resolves.toBe(
      false,
    );
  },
);

it("retries an uncertain query and observes the still-running process", async () => {
  const { run, sandbox } = fixture();
  run.mockRejectedValueOnce(new Error("connection unavailable"));
  run.mockResolvedValue({
    exitCode: 0,
    stdout: "PID CMD\n4321 sleep\n",
    stderr: "",
  });
  await expect(verifyProcessTerminated(sandbox, 4321, 2, 0)).resolves.toBe(
    false,
  );
});

it("confirms a missing PID after transient query failure", async () => {
  const { run, sandbox } = fixture();
  run.mockRejectedValueOnce(new Error("connection unavailable"));
  run.mockRejectedValue(exited(1));
  await expect(verifyProcessTerminated(sandbox, 4321, 2, 0)).resolves.toBe(
    true,
  );
  expect(run).toHaveBeenCalledTimes(2);
});

it("accepts an authoritative missing-PID command exit", async () => {
  const { run, sandbox } = fixture();
  run.mockRejectedValue(exited(1));
  await expect(verifyProcessTerminated(sandbox, 4321, 1, 0)).resolves.toBe(
    true,
  );
});

it.each([
  { exitCode: -1, stdout: "", stderr: "" },
  { exitCode: 127, stdout: "", stderr: "ps: not found" },
  { exitCode: 1, stdout: "", stderr: "ps: permission denied" },
])("does not confirm a resolved failed query: %j", async (result) => {
  const { run, sandbox } = fixture();
  run.mockResolvedValue(result);
  await expect(verifyProcessTerminated(sandbox, 4321, 1, 0)).resolves.toBe(
    false,
  );
});

it("retains the process when an exit error contains its PID", async () => {
  const { run, sandbox } = fixture();
  run.mockRejectedValue(
    new CommandExitError({
      exitCode: 1,
      stdout: "PID CMD\n4321 sleep\n",
      stderr: "",
      error: "command exited",
    }),
  );
  await expect(verifyProcessTerminated(sandbox, 4321, 1, 0)).resolves.toBe(
    false,
  );
});
