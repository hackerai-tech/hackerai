// Exact wrapper added by lib/ai/tools/utils/sandbox-command-options.ts.
// Only remove this known prefix from display text; execute the original command.
const LOCAL_PATH_PREFIX =
  'export PATH="$HOME/go/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:/usr/local/go/bin:$PATH" && ';

export function commandDisplayText(command: string): string {
  return command.startsWith(LOCAL_PATH_PREFIX)
    ? command.slice(LOCAL_PATH_PREFIX.length)
    : command;
}
