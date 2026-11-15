const KINDS = [
  "native_command_timeout",
  "native_process_error",
  "native_other",
  "invocation_rejected",
] as const;

/** How one invocation's first terminal error arose; never its text. */
export type DesktopTerminalErrorKind = (typeof KINDS)[number];

export interface DesktopTerminalErrorDiagnostic {
  readonly desktop_terminal_error_diagnostic_version: 1;
  readonly desktop_terminal_error_kind: DesktopTerminalErrorKind;
}

const PROPERTIES = [
  "desktop_terminal_error_diagnostic_version",
  "desktop_terminal_error_kind",
] as const satisfies readonly (keyof DesktopTerminalErrorDiagnostic)[];

export const DESKTOP_TERMINAL_ERROR_PROPERTIES: ReadonlySet<string> = new Set(
  PROPERTIES,
);

/** Match only the native stream command's fixed error templates. Anything
 * else, including a changed template, is `native_other`, never a guess. */
export function classifyNativeTerminalError(
  message: unknown,
): DesktopTerminalErrorKind {
  if (typeof message !== "string") return "native_other";
  if (/^Command timed out after \d{1,20}ms$/.test(message))
    return "native_command_timeout";
  if (message.startsWith("Process error: ")) return "native_process_error";
  return "native_other";
}

export function desktopTerminalErrorDiagnostic(
  kind: DesktopTerminalErrorKind,
): DesktopTerminalErrorDiagnostic {
  return Object.freeze({
    desktop_terminal_error_diagnostic_version: 1,
    desktop_terminal_error_kind: kind,
  });
}

/** Read the complete group from any property bag's own data properties, or
 * nothing at all. A getter never runs; a throwing proxy reads as nothing. */
export function readDesktopTerminalErrorDiagnostic(
  source: unknown,
): DesktopTerminalErrorDiagnostic | null {
  if (typeof source !== "object" || source === null) return null;
  try {
    const [version, kind] = PROPERTIES.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    });
    const known = KINDS.find((value) => value === kind);
    return version === 1 && known
      ? desktopTerminalErrorDiagnostic(known)
      : null;
  } catch {
    return null;
  }
}
