/** Runtime interception and UI recognition must agree on the exact request. */
export function parseCaptchaRuntimeCommand(command: string | undefined) {
  const match =
    /^hackerai-captcha (solve|release) --session ([A-Za-z0-9_-]{1,80})$/.exec(
      command?.trim() ?? "",
    );
  return match
    ? { action: match[1] as "solve" | "release", sessionName: match[2] }
    : undefined;
}
