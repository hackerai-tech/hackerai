// Desktop and Remote Control both prefer Git Bash on Windows and fall back to cmd.
export const WINDOWS_COMMAND_SHELL_GUIDANCE =
  "Windows commands use Git Bash when available, otherwise cmd.exe /C. Neither is PowerShell. Before choosing shell-specific syntax, run `echo $BASH_VERSION`: a literal `$BASH_VERSION` means cmd.exe; a version means Git Bash. Invoke powershell.exe explicitly when PowerShell is needed.";
