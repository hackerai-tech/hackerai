import type { ToolContext } from "@/types";
import {
  trackForegroundCommand,
  waitForForegroundCommands,
} from "../foreground-commands";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("foreground commands before file delivery", () => {
  it("runs commands concurrently but waits for all issued commands", async () => {
    const context = {} as ToolContext;
    const first = deferred();
    const second = deferred();
    const started: string[] = [];
    const a = trackForegroundCommand(context, async () => {
      started.push("a");
      await first.promise;
    });
    const b = trackForegroundCommand(context, async () => {
      started.push("b");
      await second.promise;
    });
    let delivered = false;
    const waiting = waitForForegroundCommands(context).then((count) => {
      delivered = true;
      return count;
    });
    expect(started).toEqual(["a", "b"]);
    first.resolve();
    await a;
    expect(delivered).toBe(false);
    second.resolve();
    await b;
    expect(await waiting).toBe(2);
    expect(await waitForForegroundCommands(context)).toBe(0);
  });

  it("isolates runs even when they have the same chat ID", async () => {
    const firstContext = { chatId: "chat" } as ToolContext;
    const secondContext = { chatId: "chat" } as ToolContext;
    const command = deferred();
    const pending = trackForegroundCommand(firstContext, () => command.promise);
    expect(await waitForForegroundCommands(secondContext)).toBe(0);
    command.resolve();
    await pending;
  });

  it("releases delivery after a rejected command without hiding its error", async () => {
    const context = {} as ToolContext;
    const finish = deferred();
    const command = trackForegroundCommand(context, async () => {
      await finish.promise;
      throw new Error("Creation denied");
    });
    const rejected = expect(command).rejects.toThrow("Creation denied");
    const waiting = waitForForegroundCommands(context);
    finish.resolve();
    await rejected;
    expect(await waiting).toBe(1);
    expect(await waitForForegroundCommands(context)).toBe(0);
  });

  it("cancels the delivery wait and removes its abort listener", async () => {
    const context = {} as ToolContext;
    const finish = deferred();
    const command = trackForegroundCommand(context, () => finish.promise);
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, "removeEventListener");
    const waiting = waitForForegroundCommands(context, controller.signal);
    const rejected = expect(waiting).rejects.toThrow("Stopped");
    controller.abort(new DOMException("Stopped", "AbortError"));
    await rejected;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    finish.resolve();
    await command;
  });
});
