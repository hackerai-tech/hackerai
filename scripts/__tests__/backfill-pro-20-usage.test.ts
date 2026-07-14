import { parseBackfillArgs } from "../backfill-pro-20-usage";

describe("backfill-pro-20-usage arguments", () => {
  it("defaults to dry-run", () => {
    expect(parseBackfillArgs([])).toEqual({
      apply: false,
      envFile: ".env.local",
    });
  });

  it("requires an expected subscription count when applying", () => {
    expect(() => parseBackfillArgs(["--apply"])).toThrow(
      "--apply requires --expected-subscriptions",
    );
  });

  it("accepts an explicit environment file and safety count", () => {
    expect(
      parseBackfillArgs([
        "--env-file=/tmp/production.env",
        "--apply",
        "--expected-subscriptions=105",
      ]),
    ).toEqual({
      apply: true,
      envFile: "/tmp/production.env",
      expectedSubscriptions: 105,
    });
  });
});
