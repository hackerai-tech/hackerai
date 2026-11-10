import { parseCaptchaRuntimeCommand } from "../runtime-command";

it.each([
  [
    "hackerai-captcha solve --session owned",
    { action: "solve", sessionName: "owned" },
  ],
  [
    " hackerai-captcha release --session owned ",
    { action: "release", sessionName: "owned" },
  ],
  [
    "hackerai-captcha progress --session owned --attempt 2 --outcome rejected",
    {
      action: "progress",
      sessionName: "owned",
      report: { attempt: 2, outcome: "rejected" },
    },
  ],
  // Malformed values still identify the owned report so they stop recovery.
  [
    "hackerai-captcha progress --session owned --attempt 0 --outcome maybe",
    { action: "progress", sessionName: "owned", report: undefined },
  ],
])("recognizes the exact runtime request %j", (command, expected) => {
  expect(parseCaptchaRuntimeCommand(command)).toEqual(expected);
});

it.each([
  undefined,
  "hackerai-captcha solve --session owned; echo extra",
  "hackerai-captcha progress --session owned --attempt 1",
  "hackerai-captcha progress --session owned --outcome advanced --attempt 1",
  "hackerai-captcha progress --session owned --attempt 1 --outcome advanced | cat",
  "hackerai-captcha progress --session owned --attempt 1 --outcome advanced;id",
  "hackerai-captcha progress --session owned --attempt 1 --outcome advanced --extra",
  "echo hackerai-captcha progress --session owned --attempt 1 --outcome advanced",
])("rejects a composed or incomplete request %j", (command) => {
  expect(parseCaptchaRuntimeCommand(command)).toBeUndefined();
});
