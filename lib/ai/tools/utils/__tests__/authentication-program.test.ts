import { execFile, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AUTHENTICATION_PROGRAM,
  authenticationCommand,
  type AuthenticationRequest,
} from "../authentication-program";

const execute = promisify(execFile);
const python = process.env.HACKERAI_AUTH_TEST_PYTHON ?? "python3";
const secret = "synthetic-session-DO-NOT-OUTPUT";
const secondSecret = "synthetic-csrf-DO-NOT-OUTPUT";
let directory: string;
let server: Server;
let foreign: Server;
let origin: string;
let foreignOrigin: string;
let foreignRequests = 0;
let observed: Array<{ path: string; cookie: string | undefined }>;
let slowStarted: (() => void) | undefined;

async function listen(value: Server) {
  await new Promise<void>((resolve) => value.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(value.address() as { port: number }).port}`;
}

async function fixtureFile(name: string, value: string) {
  const path = join(directory, name);
  await writeFile(path, value, { mode: 0o600 });
  return path;
}

async function input(
  format: AuthenticationRequest["credential_format"] = "cookie_header",
  raw = `sid=${secret}; csrf=${secondSecret}`,
  path = "/me",
) {
  return {
    url: `${origin}${path}`,
    credential_file: await fixtureFile("credentials", raw),
    credential_format: format,
    expectation_file: await fixtureFile(
      "expected.json",
      JSON.stringify({
        origin,
        identity_pointer: "/user/id",
        identity: "alice",
      }),
    ),
  };
}

async function diagnose(request: AuthenticationRequest) {
  const result = await execute(python, [
    "-c",
    AUTHENTICATION_PROGRAM,
    JSON.stringify(request),
  ]);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain(secret);
  expect(result.stdout).not.toContain(secondSecret);
  expect(result.stdout).not.toContain("alice");
  expect(result.stdout).not.toContain("storage-secret");
  return JSON.parse(result.stdout);
}

function jarRow(
  name: string,
  value: string,
  { domain = "127.0.0.1", path = "/", secure = false, expires = 0 } = {},
) {
  return `${domain}\t${domain.startsWith(".") ? "TRUE" : "FALSE"}\t${path}\t${secure ? "TRUE" : "FALSE"}\t${expires}\t${name}\t${value}`;
}
const jar = (...rows: string[]) =>
  `# Netscape HTTP Cookie File\n${rows.join("\n")}\n`;
const browserCookie = (name = "sid", value = secret) => ({
  name,
  value,
  domain: "127.0.0.1",
  path: "/",
  secure: false,
  httpOnly: true,
  expires: -1,
  sameSite: "Lax",
});

beforeAll(async () => {
  // Requests is already in the Cloud image. CI installs its fixture dependency;
  // local contributors can select an isolated venv through this environment var.
  await execute(python, ["-c", "import requests"]);
  directory = await mkdtemp(join(tmpdir(), "hackerai-auth-test-"));
  foreign = createServer((_req, res) => {
    foreignRequests++;
    res.end("unexpected");
  });
  foreignOrigin = await listen(foreign);
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    observed.push({ path, cookie: req.headers.cookie });
    if (path === "/slow") {
      slowStarted?.();
      return;
    }
    if (path === "/redirect" || path === "/foreign") {
      res.writeHead(302, {
        location: path === "/foreign" ? `${foreignOrigin}/me` : "/login",
      });
      res.end();
      return;
    }
    if (path === "/challenge") {
      res.writeHead(200, {
        "cf-mitigated": "challenge",
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ user: { id: "alice" } }));
      return;
    }
    if (path === "/login" || path === "/captcha") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        path === "/captcha"
          ? '<div class="h-captcha">Verify</div>'
          : "<form>Sign in alice</form>",
      );
      return;
    }
    res.setHeader("content-type", "application/json");
    if (path === "/401") {
      res.statusCode = 401;
      res.end(secret);
      return;
    }
    if (path === "/error") {
      res.end(JSON.stringify({ error: secret, user: { id: "alice" } }));
      return;
    }
    if (path === "/anonymous") {
      res.end(JSON.stringify({ authenticated: false, user: { id: "alice" } }));
      return;
    }
    if (path === "/missing") {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === "/large") {
      res.end(secret.repeat(20000));
      return;
    }
    if (path === "/bob") {
      res.end(JSON.stringify({ user: { id: "bob" } }));
      return;
    }
    if (!req.headers.cookie?.includes(`sid=${secret}`)) {
      res.statusCode = 401;
      res.end("{}");
      return;
    }
    res.end(JSON.stringify({ user: { id: "alice" }, echoedSecret: secret }));
  });
  origin = await listen(server);
});

beforeEach(() => {
  observed = [];
  foreignRequests = 0;
});
afterAll(async () => {
  for (const value of [server, foreign]) {
    value?.closeAllConnections();
    if (value)
      await new Promise<void>((resolve) => value.close(() => resolve()));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("reproduces curl raw-file omission and verifies the corrected request on the receiving server", async () => {
  const request = await input(
    "cookie_header",
    `sid=${secret}\ncsrf=${secondSecret}\n`,
  );
  await execute("curl", [
    "--silent",
    "--show-error",
    "--noproxy",
    "*",
    "-b",
    request.credential_file,
    request.url,
  ]);
  expect(observed).toEqual([{ path: "/me", cookie: undefined }]);
  observed = [];
  expect(
    await diagnose({ ...request, credential_format: "netscape" }),
  ).toMatchObject({ outcome: "invalid_cookie_format" });
  expect(observed).toHaveLength(0);
  expect(await diagnose(request)).toMatchObject({
    outcome: "authenticated",
    attachment: "client_request_verified",
    expiry_proven: false,
    cookies_in_input: 2,
  });
  expect(observed).toEqual([
    { path: "/me", cookie: `sid=${secret}; csrf=${secondSecret}` },
  ]);
  expect(authenticationCommand(request)).not.toContain(secret);
});

test.each(["cookie_header", "netscape", "browser_state"] as const)(
  "uses valid %s credentials without printing values",
  async (format) => {
    const raw =
      format === "cookie_header"
        ? `Cookie: sid=${secret}; csrf=${secondSecret}`
        : format === "netscape"
          ? jar(jarRow("sid", secret), jarRow("csrf", secondSecret))
          : JSON.stringify({
              cookies: [browserCookie(), browserCookie("csrf", secondSecret)],
              origins: [
                {
                  origin,
                  localStorage: [{ name: "token", value: "storage-secret" }],
                  sessionStorage: [{ name: "key", value: "storage-secret" }],
                },
              ],
            });
    expect(await diagnose(await input(format, raw))).toMatchObject({
      outcome: "authenticated",
      browser_storage_used: false,
    });
    expect(observed[0].cookie).toBe(`sid=${secret}; csrf=${secondSecret}`);
  },
);

test("preserves jar domain, path, secure, expiry and multiple cookies", async () => {
  const raw = jar(
    jarRow("sid", secret),
    jarRow("csrf", secondSecret, { path: "/api" }),
    jarRow("wrongDomain", "omit", { domain: "example.invalid" }),
    jarRow("wrongPath", "omit", { path: "/ap" }),
    jarRow("secure", "omit", { secure: true }),
    jarRow("expired", "omit", { expires: 1 }),
  );
  expect(await diagnose(await input("netscape", raw, "/api/me"))).toMatchObject(
    { outcome: "authenticated", cookies_in_input: 6 },
  );
  expect(observed[0].cookie).toBe(`csrf=${secondSecret}; sid=${secret}`);
});

test("preserves browser cookie scopes and rejects unsupported partitioned cookies", async () => {
  const cookies = [
    browserCookie(),
    { ...browserCookie("secure", "omit"), secure: true },
    { ...browserCookie("expired", "omit"), expires: 1 },
    { ...browserCookie("path", "omit"), path: "/other" },
    { ...browserCookie("domain", "omit"), domain: "example.invalid" },
  ];
  expect(
    await diagnose(
      await input("browser_state", JSON.stringify({ cookies, origins: [] })),
    ),
  ).toMatchObject({ outcome: "authenticated" });
  expect(observed[0].cookie).toBe(`sid=${secret}`);
  observed = [];
  expect(
    await diagnose(
      await input(
        "browser_state",
        JSON.stringify({
          cookies: [
            { ...browserCookie(), partitionKey: { topLevelSite: origin } },
          ],
          origins: [],
        }),
      ),
    ),
  ).toMatchObject({ outcome: "unsupported_cookie_semantics" });
  expect(observed).toHaveLength(0);
});

test.each([
  ["cookie_header", "sid=ok\r\nAuthorization: Bearer secret"],
  ["cookie_header", "sid=ok; Path=/"],
  ["netscape", jar("bad\tTRUE\t/\tFALSE\t0\tsid\t" + secret)],
  ["netscape", jar(".example.com\tFALSE\t/\tFALSE\t0\tsid\t" + secret)],
  ["browser_state", '{"cookies":[] }'],
  [
    "browser_state",
    JSON.stringify({
      cookies: [{ ...browserCookie(), expires: "tomorrow" }],
      origins: [],
    }),
  ],
] as const)(
  "rejects malformed %s before network I/O, including secret-bearing parser errors",
  async (format, raw) => {
    expect(await diagnose(await input(format, raw))).toMatchObject({
      outcome: "invalid_cookie_format",
    });
    expect(observed).toHaveLength(0);
  },
);

test("does not send an unauthenticated probe when no cookie matches or state only contains storage", async () => {
  const request = await input(
    "netscape",
    jar(jarRow("sid", secret, { secure: true })),
  );
  expect(await diagnose(request)).toMatchObject({
    outcome: "credentials_not_sent",
    attachment: "not_sent",
  });
  expect(
    await diagnose(
      await input(
        "browser_state",
        JSON.stringify({
          cookies: [],
          origins: [
            {
              origin,
              localStorage: [{ name: "token", value: "storage-secret" }],
            },
          ],
        }),
      ),
    ),
  ).toMatchObject({ outcome: "credentials_not_sent" });
  expect(observed).toHaveLength(0);
});

test.each([
  ["/login", "authentication_unverified", "expected_json_identity_response"],
  ["/redirect", "authentication_unverified", "redirect_not_followed"],
  ["/foreign", "authentication_unverified", "redirect_not_followed"],
  ["/401", "authentication_failed", "endpoint_rejected_request_cause_unknown"],
  ["/challenge", "challenge_required", "response_challenge_header"],
  ["/captcha", "challenge_required", "response_challenge_marker"],
  ["/bob", "identity_mismatch", "unexpected_identity"],
  ["/error", "authentication_unverified", "error_or_unauthenticated_response"],
  [
    "/anonymous",
    "authentication_unverified",
    "error_or_unauthenticated_response",
  ],
  ["/missing", "authentication_unverified", "identity_missing"],
  ["/large", "authentication_unverified", "response_too_large"],
])(
  "does not mistake %s for authenticated success or expiry",
  async (path, outcome, reason) => {
    expect(
      await diagnose(await input("cookie_header", `sid=${secret}`, path)),
    ).toMatchObject({ outcome, reason, expiry_proven: false });
    expect(observed).toHaveLength(1);
    expect(foreignRequests).toBe(0);
  },
);

test("binds the check to the expected account origin and rejects non-private or symlink inputs", async () => {
  const request = await input();
  expect(
    await diagnose({ ...request, url: `${foreignOrigin}/me` }),
  ).toMatchObject({
    outcome: "invalid_endpoint",
    reason: "expected_origin_mismatch",
  });
  await chmod(request.credential_file, 0o644);
  expect(await diagnose(request)).toMatchObject({
    outcome: "input_unavailable",
    reason: "private_file_required",
  });
  await chmod(request.credential_file, 0o600);
  const link = join(directory, "linked");
  await symlink(request.credential_file, link);
  expect(await diagnose({ ...request, credential_file: link })).toMatchObject({
    outcome: "input_unavailable",
  });
  expect(observed).toHaveLength(0);
  expect(foreignRequests).toBe(0);
});

test("cancellation interrupts an in-flight request without exposing credentials", async () => {
  const request = await input("cookie_header", `sid=${secret}`, "/slow");
  const started = new Promise<void>((resolve) => {
    slowStarted = resolve;
  });
  const child = spawn(python, [
    "-c",
    AUTHENTICATION_PROGRAM,
    JSON.stringify(request),
  ]);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const finished = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  try {
    await started;
    child.kill("SIGTERM");
    await finished;
    expect(JSON.parse(output)).toMatchObject({
      outcome: "cancelled",
      expiry_proven: false,
    });
    expect(output).not.toContain(secret);
    expect(observed).toHaveLength(1);
  } finally {
    child.kill("SIGKILL");
    slowStarted = undefined;
    server.closeAllConnections();
  }
});

test("host-only cookies never match a subdomain; domain cookies require a label boundary", async () => {
  const raw = jar(
    jarRow("host", secret, { domain: "example.com" }),
    jarRow("domain", secondSecret, { domain: ".example.com" }),
  );
  const program = `${AUTHENTICATION_PROGRAM}\nprint(json.dumps([scoped_header(${JSON.stringify(raw)}, 'netscape', url)[0] for url in ['https://example.com/me', 'https://sub.example.com/me', 'https://badexample.com/me']]))`;
  // Import mode exposes only the pure scope function; the synthetic values are
  // test data and are never used by the production command builder.
  const { stdout } = await execute(python, [
    "-c",
    program.replace("if __name__ == '__main__':", "if False:"),
  ]);
  expect(JSON.parse(stdout)).toEqual([
    `host=${secret}; domain=${secondSecret}`,
    `domain=${secondSecret}`,
    "",
  ]);
});

test("detects credentials removed at dispatch using the real fixture transport", async () => {
  const request = await input();
  const program = `${AUTHENTICATION_PROGRAM.replace("if __name__ == '__main__':", "if False:")}
import requests
original_send = requests.adapters.HTTPAdapter.send
def omit_cookie(self, request, **kwargs):
    request.headers.pop('Cookie', None)
    return original_send(self, request, **kwargs)
requests.adapters.HTTPAdapter.send = omit_cookie
print(json.dumps(main(json.loads(sys.argv[1]))))
`;
  const { stdout, stderr } = await execute(python, [
    "-c",
    program,
    JSON.stringify(request),
  ]);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({
    outcome: "credentials_not_sent",
    reason: "dispatched_request_missing_cookies",
  });
  expect(observed).toEqual([{ path: "/me", cookie: undefined }]);
  expect(stdout).not.toContain(secret);
});

test("reports a missing installed request library without installing or attempting network I/O", async () => {
  const { stdout, stderr } = await execute(python, [
    "-S",
    "-c",
    AUTHENTICATION_PROGRAM,
    JSON.stringify(await input()),
  ]);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({
    outcome: "unsupported_runtime",
    reason: "python_requests_unavailable",
  });
  expect(observed).toHaveLength(0);
});
