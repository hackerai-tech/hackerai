// Desktop and Remote Control both prefer Git Bash on Windows and fall back to cmd.
export const WINDOWS_COMMAND_SHELL_GUIDANCE =
  "Windows commands use Git Bash when available, otherwise cmd.exe /C. Neither is PowerShell. Before choosing shell-specific syntax, run `echo $BASH_VERSION`: a literal `$BASH_VERSION` means cmd.exe; a version means Git Bash. In Git Bash, quote file paths and use forward-slash drive paths such as `C:/...`; unquoted Windows backslashes are shell escapes. In cmd.exe, use double-quoted Windows paths. Invoke powershell.exe explicitly when PowerShell is needed.";
