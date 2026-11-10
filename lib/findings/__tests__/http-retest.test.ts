/** @jest-environment node */
import { describe, expect, it } from "@jest/globals";
import {
  classifyHttpRetest,
  parseHttpRetestRecipe,
  type HttpRetestRecipe,
  type HttpRetestRunnerOutput,
  type HttpRetestStep,
} from "../http-retest";

const idorRecipe = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  title: "Invoice IDOR",
  origin: "http://127.0.0.1:4010",
  timeout_ms: 2000,
  credentials: [
    { name: "tester_token", label: "Tester token", placement: "bearer" },
  ],
  baselines: [
    {
      label: "Own invoice",
      method: "GET",
      path: "/api/invoices/inv_1002",
      credential: "tester_token",
      headers: [{ name: "Accept", value: "application/json" }],
      expect: {
        status: 200,
        json: [{ json_path: "owner_id", equals: "usr_tester_b" }],
        body_contains: [],
      },
    },
  ],
  probe: {
    label: "Victim invoice",
    method: "GET",
    path: "/api/invoices/inv_1001",
    credential: "tester_token",
    headers: [],
    vulnerable: {
      status: 200,
      json: [{ json_path: "owner_id", equals: "usr_victim_a" }],
      body_contains: [],
    },
    not_reproduced: { statuses: [403, 404] },
  },
  ...overrides,
});

const parse = (value: unknown) => parseHttpRetestRecipe(value);
const recipe = parse(idorRecipe()) as {
  success: true;
  recipe: HttpRetestRecipe;
};

const step = (overrides: Partial<HttpRetestStep>): HttpRetestStep => ({
  kind: "baseline",
  index: 0,
  status: 200,
  bytes: 30,
  body_sha256: "a".repeat(64),
  duration_ms: 5,
  error: "none",
  matched: true,
  checks: [true],
  ...overrides,
});

const output = (
  steps: HttpRetestStep[],
  deadline = false,
): HttpRetestRunnerOutput => ({
  protocol: 1,
  steps,
  deadline_exceeded: deadline,
});

describe("HTTP retest recipe policy", () => {
  it("accepts the IDOR recipe with an own-record baseline and runtime credential", () => {
    expect(recipe.success).toBe(true);
  });

  it.each([
    ["an origin with a path", { origin: "https://app.test/api" }],
    ["embedded origin credentials", { origin: "https://u:p@app.test" }],
    ["a non-HTTP origin", { origin: "file:///etc" }],
  ])("rejects %s", (_name, overrides) => {
    expect(parse(idorRecipe(overrides)).success).toBe(false);
  });

  it.each([
    "//evil.test/a",
    "https://evil.test/a",
    "/a#frag",
    "/a b",
    "relative",
    "/\\evil",
  ])("rejects a path that could leave the origin: %s", (path) => {
    const value = idorRecipe();
    (value.probe as any).path = path;
    expect(parse(value).success).toBe(false);
  });

  it("never lets 401 count as not reproduced", () => {
    const value = idorRecipe();
    (value.probe as any).not_reproduced = { statuses: [401, 403] };
    expect(parse(value).success).toBe(false);
  });

  it("requires baselines to prove an identity, not just any 2xx", () => {
    const value = idorRecipe();
    (value.baselines[0] as any).expect = {
      status: 200,
      json: [],
      body_contains: [],
    };
    expect(parse(value)).toMatchObject({ success: false });
  });

  it("rejects hostile or credential-bearing literal headers", () => {
    for (const name of ["Host", "Authorization", "Cookie", "X-Forwarded-For"]) {
      const value = idorRecipe();
      (value.baselines[0] as any).headers = [{ name, value: "x" }];
      expect(parse(value).success).toBe(false);
    }
    const header = idorRecipe({
      credentials: [
        {
          name: "tester_token",
          label: "Key",
          placement: "header",
          header_name: "X-Forwarded-Host",
        },
      ],
    });
    expect(parse(header).success).toBe(false);
  });

  it("requires every credential reference to be declared and every declaration used", () => {
    const undeclared = idorRecipe();
    (undeclared.probe as any).credential = "victim_token";
    expect(parse(undeclared).success).toBe(false);
    const unused = idorRecipe({
      credentials: [
        { name: "tester_token", label: "T", placement: "bearer" },
        { name: "spare", label: "S", placement: "bearer" },
      ],
    });
    expect(parse(unused).success).toBe(false);
  });

  it("rejects non-GET methods and request bodies", () => {
    const post = idorRecipe();
    (post.probe as any).method = "POST";
    expect(parse(post).success).toBe(false);
    const body = idorRecipe();
    (body.probe as any).body = "{}";
    expect(parse(body).success).toBe(false);
  });
});

describe("HTTP retest classification", () => {
  const r = recipe.recipe;

  it("reproduces only when the explicit vulnerable predicate matches", () => {
    expect(
      classifyHttpRetest(
        r,
        output([step({}), step({ kind: "probe", matched: true })]),
      ),
    ).toEqual({
      outcome: "reproduced",
      reason: "vulnerable_predicate_matched",
    });
  });

  it("is not reproduced only for an explicit denial status", () => {
    expect(
      classifyHttpRetest(
        r,
        output([
          step({}),
          step({
            kind: "probe",
            status: 403,
            matched: false,
            nonreproduction_matched: true,
          }),
        ]),
      ),
    ).toEqual({
      outcome: "not_reproduced",
      reason: "nonreproduction_predicate_matched",
    });
  });

  it("skips a probe 401 even if the server is otherwise fixed", () => {
    expect(
      classifyHttpRetest(
        r,
        output([
          step({}),
          step({ kind: "probe", status: 401, matched: false }),
        ]),
      ),
    ).toEqual({ outcome: "skipped", reason: "auth_rejected" });
  });

  it("skips an unexpected probe response instead of calling it fixed", () => {
    expect(
      classifyHttpRetest(
        r,
        output([
          step({}),
          step({ kind: "probe", status: 500, matched: false }),
        ]),
      ),
    ).toEqual({ outcome: "skipped", reason: "unexpected_response" });
  });

  it("skips when a baseline returns 2xx but not the expected own record", () => {
    expect(
      classifyHttpRetest(
        r,
        output([step({ matched: false, checks: [false] })]),
      ),
    ).toEqual({ outcome: "skipped", reason: "baseline_mismatch" });
  });

  it("maps transport failures to skipped or error, never not reproduced", () => {
    expect(
      classifyHttpRetest(r, output([step({ error: "redirect", status: 302 })])),
    ).toEqual({ outcome: "skipped", reason: "redirect_refused" });
    expect(
      classifyHttpRetest(
        r,
        output([step({}), step({ kind: "probe", error: "oversized" })]),
      ),
    ).toEqual({ outcome: "skipped", reason: "response_too_large" });
    expect(
      classifyHttpRetest(
        r,
        output([step({ error: "connection", status: null })]),
      ),
    ).toEqual({ outcome: "error", reason: "target_unreachable" });
    expect(classifyHttpRetest(r, output([step({})], true))).toEqual({
      outcome: "error",
      reason: "timeout",
    });
  });
});
