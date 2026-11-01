import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
// Resolve the DOM fixture library owned by the existing Jest environment.
const { JSDOM } = createRequire(import.meta.resolve("jest-environment-jsdom"))(
  "jsdom",
);
import { diagnoseLogin } from "./login-state.mjs";

const secret = "SYNTHETIC_LOGIN_SECRET_987654";
function tabFor(
  html,
  url = "https://signin.hackerai.co/password?code=" + secret,
) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  return {
    url: async () => url,
    playwright: {
      evaluate: async (fn) => dom.window.eval("(" + fn.toString() + ")()"),
    },
  };
}
test("real DOM signals distinguish forms without returning values, text, URL codes or identifiers", async () => {
  for (const [html, state] of [
    [
      "<h1>" +
        secret +
        '</h1><input type="password" value="' +
        secret +
        '"><input type="email" value="private@example.invalid">',
      "password-entry",
    ],
    ['<input type="email" value="private@example.invalid">', "email-entry"],
    [
      "<p>Verification code " +
        secret +
        '</p><input autocomplete="one-time-code" value="123456">',
      "verification-required",
    ],
    [
      '<iframe src="https://captcha.invalid/recaptcha?secret=' +
        secret +
        '"></iframe>',
      "challenge",
    ],
    [
      '<button data-testid="user-menu">' + secret + "</button>",
      "session-ui-present",
    ],
    [
      "<h1>" +
        secret +
        '</h1><script type="application/json">{"password":"' +
        secret +
        '"}</script>',
      "unknown",
    ],
  ]) {
    const result = await diagnoseLogin(tabFor(html));
    assert.deepEqual(result, { origin: "https://signin.hackerai.co", state });
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes("private@"), false);
  }
});
test("unsupported origins are rejected before DOM inspection; explicit fixture origins work", async () => {
  const tab = tabFor(
    '<input type="password">',
    "https://signin.hackerai.co.attacker.invalid/?token=" + secret,
  );
  tab.playwright.evaluate = () => assert.fail("must not inspect");
  assert.deepEqual(await diagnoseLogin(tab), {
    origin: null,
    state: "unsupported-origin",
  });
  assert.deepEqual(
    await diagnoseLogin(
      tabFor('<input type="password">', "http://127.0.0.1:1234"),
      { allowedOrigins: ["http://127.0.0.1:1234"] },
    ),
    { origin: "http://127.0.0.1:1234", state: "password-entry" },
  );
});
test("navigation, tool errors and unknown result envelopes fail closed without raw details", async () => {
  const tab = tabFor('<input type="password">');
  let calls = 0;
  tab.url = async () =>
    ++calls === 1
      ? "https://signin.hackerai.co/password"
      : "https://hackerai.co/?code=" + secret;
  assert.deepEqual(await diagnoseLogin(tab), {
    origin: null,
    state: "page-changed",
  });
  tab.url = async () => "https://signin.hackerai.co/password";
  tab.playwright.evaluate = async () => {
    throw new Error(secret + ' {"raw":{"password":"' + secret + '"}}');
  };
  assert.deepEqual(await diagnoseLogin(tab), {
    origin: null,
    state: "unavailable",
  });
  tab.playwright.evaluate = async () => ({
    password: true,
    email: false,
    verification: false,
    challenge: false,
    sessionUi: false,
    raw: secret,
  });
  assert.deepEqual(await diagnoseLogin(tab), {
    origin: "https://signin.hackerai.co",
    state: "unavailable",
  });
});
test("an unresponsive read returns a bounded unavailable state", async () => {
  const tab = tabFor("");
  tab.url = () => new Promise(() => {});
  assert.deepEqual(await diagnoseLogin(tab, { timeoutMs: 15 }), {
    origin: null,
    state: "unavailable",
  });
});
test("split OTP controls take priority over password fields", async () => {
  const html =
    '<input type="password">' +
    '<input inputmode="numeric" maxlength="1" value="9">'.repeat(6);
  assert.equal(
    (await diagnoseLogin(tabFor(html))).state,
    "verification-required",
  );
});
