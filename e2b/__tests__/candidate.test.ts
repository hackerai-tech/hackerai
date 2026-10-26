import { Template } from "e2b";
import { buildCandidate } from "../candidate";

jest.mock("e2b", () => ({
  Template: { build: jest.fn(), getTags: jest.fn() },
}));
jest.mock("../template", () => ({ template: {} }));

const build = jest.mocked(Template.build);
const tags = jest.mocked(Template.getTags);
const env = { E2B_API_KEY: "test-us-key", E2B_EU_API_KEY: "test-eu-key" };
const tag = "candidate-test";
const oldTag = { tag: "default", buildId: "old", createdAt: new Date() };

beforeEach(() => {
  jest.resetAllMocks();
  build.mockResolvedValue({
    templateId: "template",
    buildId: "new",
    name: "name",
    alias: "name",
    tags: [tag],
  });
  tags
    .mockResolvedValueOnce([oldTag])
    .mockResolvedValue([oldTag, { ...oldTag, tag, buildId: "new" }]);
});

it.each(["us-dev", "us-prod", "eu-dev", "eu-prod"])(
  "builds %s as a candidate with unchanged resources and an exact validation reference",
  async (target) => {
    await expect(buildCandidate(target, tag, env)).resolves.toMatchObject({
      validationReference: "template:new",
      previousDefaultBuildId: "old",
      envdVerification: "required_on_fresh_sandbox",
    });
    expect(build).toHaveBeenCalledWith(
      {},
      `terminal-agent-sandbox${target.endsWith("dev") ? "-dev" : ""}:${tag}`,
      expect.objectContaining({
        apiKey: target.startsWith("eu") ? env.E2B_EU_API_KEY : env.E2B_API_KEY,
        domain: target.startsWith("eu") ? "e2b-juliett.dev" : "e2b.dev",
        apiUrl: target.startsWith("eu")
          ? "https://api.e2b-juliett.dev"
          : "https://api.e2b.dev",
        debug: false,
        skipCache: true,
        cpuCount: 4,
        memoryMB: 4096,
        retries: 0,
      }),
    );
  },
);

it.each(["default", "production", "", "candidate-x:default"])(
  "refuses unsafe tag %s before calling E2B",
  async (value) => {
    await expect(buildCandidate("us-dev", value, env)).rejects.toThrow();
    expect(tags).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  },
);

it("refuses a missing regional key rather than falling back to the US project", async () => {
  await expect(
    buildCandidate("eu-dev", tag, { E2B_API_KEY: "test" }),
  ).rejects.toThrow();
  expect(build).not.toHaveBeenCalled();
});

it("rejects malformed regional hosts before sending credentials", async () => {
  await expect(
    buildCandidate("eu-dev", tag, { ...env, E2B_EU_DOMAIN: "host/path" }),
  ).rejects.toThrow();
  expect(tags).not.toHaveBeenCalled();
  expect(build).not.toHaveBeenCalled();
});

it.each([{ existing: [] }, { existing: [oldTag, { ...oldTag, tag }] }])(
  "refuses a missing default or existing candidate before building",
  async ({ existing }) => {
    tags.mockReset().mockResolvedValue(existing);
    await expect(buildCandidate("us-dev", tag, env)).rejects.toThrow();
    expect(build).not.toHaveBeenCalled();
  },
);

it("fails readback if the default moved, without attempting to overwrite concurrent work", async () => {
  tags
    .mockReset()
    .mockResolvedValueOnce([oldTag])
    .mockResolvedValue([
      { ...oldTag, buildId: "unexpected" },
      { ...oldTag, tag, buildId: "new" },
    ]);
  await expect(buildCandidate("us-dev", tag, env)).rejects.toThrow(
    "Tag readback mismatch",
  );
  expect(build).toHaveBeenCalledTimes(1);
});
