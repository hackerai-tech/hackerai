import { commandDisplayText } from "../command-display";
import { augmentCommandPath } from "../../../../lib/ai/tools/utils/sandbox-command-options";
import type { AnySandbox } from "../../../../types";

const prefix =
  'export PATH="$HOME/go/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:/usr/local/go/bin:$PATH" && ';

describe("command display", () => {
  it("recognizes the current server wrapper", () => {
    const sandbox = {
      sandboxKind: "centrifugo",
      isWindows: () => false,
    } as unknown as AnySandbox;
    expect(commandDisplayText(augmentCommandPath("echo test", sandbox))).toBe(
      "echo test",
    );
  });
  it("removes only the tool setup wrapper, preserving the user command verbatim", () => {
    const command =
      'export PATH="/my/tools:$PATH" && printf "hello\\n"\nprintf "done"';
    expect(commandDisplayText(prefix + command)).toBe(command);
  });

  it.each([
    'export PATH="/my/tools:$PATH" && scan',
    'printf "export PATH"',
    `echo setup && ${prefix}scan`,
    'set "PATH=C:\\tools;%PATH%" && scan',
    'printf "hello"',
  ])("preserves a command without the exact setup prefix: %s", (command) => {
    expect(commandDisplayText(command)).toBe(command);
  });
});
