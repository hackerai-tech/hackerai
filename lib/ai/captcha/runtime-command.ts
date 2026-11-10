import {
  parseVisionProgressReport,
  type VisionProgressReport,
} from "./vision-progress";

/** Runtime interception and UI recognition must agree on the exact request. */
export function parseCaptchaRuntimeCommand(command: string | undefined):
  | { action: "solve" | "release"; sessionName: string }
  | {
      action: "progress";
      sessionName: string;
      /** Undefined when the values are malformed; recorded as uncertain. */
      report: VisionProgressReport | undefined;
    }
  | undefined {
  const trimmed = command?.trim() ?? "";
  const match =
    /^hackerai-captcha (solve|release) --session ([A-Za-z0-9_-]{1,80})$/.exec(
      trimmed,
    );
  if (match)
    return { action: match[1] as "solve" | "release", sessionName: match[2] };
  const progress =
    /^hackerai-captcha progress --session ([A-Za-z0-9_-]{1,80}) --attempt ([A-Za-z0-9_.+-]{1,20}) --outcome ([A-Za-z0-9_.+-]{1,20})$/.exec(
      trimmed,
    );
  return progress
    ? {
        action: "progress",
        sessionName: progress[1],
        report: parseVisionProgressReport(progress[2], progress[3]),
      }
    : undefined;
}
