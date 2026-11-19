import { describe, expect, it, jest } from "@jest/globals";
import {
  getQaSpendPolicyStatus,
  resolveQaSpendPool,
} from "../qa-spending-policy";

// Synthetic WorkOS-shaped IDs (`user_` + 26 characters); no real accounts.
const workosId = (tag: string) => `user_${tag.padEnd(26, "0")}`;
const QA_USER = workosId("01QAROUTINEA");
const OTHER_QA_USER = workosId("01QAROUTINEB");
const BILLING_FIXTURE = workosId("01BILLINGFIXTURE");

const previewVercel = {
  QA_MONTHLY_QUOTA_USER_IDS: `${QA_USER}, ${OTHER_QA_USER}`,
  QA_SPEND_CAP_DOLLARS: "25",
  HACKERAI_ENVIRONMENT: "preview",
  VERCEL: "1",
  VERCEL_ENV: "preview",
  VERCEL_TARGET_ENV: "preview",
  TRIGGER_SECRET_KEY: "tr_preview_synthetic",
  WORKOS_API_KEY: "sk_test_synthetic",
};
const developmentLocal = {
  QA_MONTHLY_QUOTA_USER_IDS: QA_USER,
  QA_SPEND_CAP_DOLLARS: "25",
  HACKERAI_ENVIRONMENT: "development",
  TRIGGER_SECRET_KEY: "tr_dev_synthetic",
  WORKOS_API_KEY: "sk_test_synthetic",
};

describe("resolveQaSpendPool", () => {
  it("gives approved personal paid users an environment-specific pool sized in billable points", () => {
    const preview = resolveQaSpendPool(QA_USER, "pro", previewVercel);
    const development = resolveQaSpendPool(QA_USER, "ultra", developmentLocal);

    // $25 raw spend at the 1.3x usage multiplier and 10,000 points per dollar.
    expect(preview).toEqual({
      environment: "preview",
      storageKey: "usage:qa-spend:v1:preview",
      capPoints: 325_000,
    });
    expect(development).toMatchObject({ environment: "development" });
    expect(development!.storageKey).not.toBe(preview!.storageKey);
    expect(
      resolveQaSpendPool(OTHER_QA_USER, "pro-plus", previewVercel),
    ).not.toBeNull();
  });

  it("accepts a managed Trigger Preview worker without Vercel variables", () => {
    const triggerPreview = {
      ...previewVercel,
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_TARGET_ENV: undefined,
      TRIGGER_DEPLOYMENT_VERSION: "synthetic-worker",
    };
    expect(resolveQaSpendPool(QA_USER, "pro", triggerPreview)).toMatchObject({
      environment: "preview",
    });
  });

  it("never exempts Free, Team or unlisted users", () => {
    expect(resolveQaSpendPool(QA_USER, "free", previewVercel)).toBeNull();
    expect(resolveQaSpendPool(QA_USER, "team", previewVercel)).toBeNull();
    expect(
      resolveQaSpendPool(workosId("01UNLISTED"), "pro", previewVercel),
    ).toBeNull();
  });

  it.each([
    [
      "Vercel Production with a mistaken preview label",
      { VERCEL_ENV: "production" },
    ],
    ["a Production deployment target", { VERCEL_TARGET_ENV: "production" }],
    ["a custom staging target", { VERCEL_TARGET_ENV: "staging" }],
    ["a missing Vercel target", { VERCEL_TARGET_ENV: undefined }],
    [
      "a live authentication environment",
      { WORKOS_API_KEY: "sk_live_synthetic" },
    ],
    [
      "a Trigger Production key",
      { VERCEL_ENV: undefined, TRIGGER_SECRET_KEY: "tr_prod_synthetic" },
    ],
    [
      "a Trigger staging key",
      { VERCEL_ENV: undefined, TRIGGER_SECRET_KEY: "tr_stg_synthetic" },
    ],
    [
      "a Development key in Preview",
      { TRIGGER_SECRET_KEY: "tr_dev_synthetic" },
    ],
    ["no Trigger key", { TRIGGER_SECRET_KEY: undefined }],
    ["no HACKERAI_ENVIRONMENT", { HACKERAI_ENVIRONMENT: undefined }],
    ["an unknown environment label", { HACKERAI_ENVIRONMENT: "staging" }],
    [
      "a label contradicting Vercel",
      { HACKERAI_ENVIRONMENT: "development", TRIGGER_SECRET_KEY: "tr_dev_x" },
    ],
  ])("denies an approved ID under %s", (_name, overrides) => {
    const env = { ...previewVercel, ...overrides };
    expect(getQaSpendPolicyStatus(env)).toEqual({
      status: "inactive_environment",
    });
    expect(resolveQaSpendPool(QA_USER, "pro", env)).toBeNull();
  });

  it("is disabled without an allow list", () => {
    const env = { ...previewVercel, QA_MONTHLY_QUOTA_USER_IDS: " , " };
    expect(getQaSpendPolicyStatus(env)).toEqual({ status: "disabled" });
    expect(resolveQaSpendPool(QA_USER, "pro", env)).toBeNull();
  });

  it.each([
    ["an email", { QA_MONTHLY_QUOTA_USER_IDS: "qa@example.com" }],
    ["a wildcard", { QA_MONTHLY_QUOTA_USER_IDS: `${QA_USER},*` }],
    ["a partial ID", { QA_MONTHLY_QUOTA_USER_IDS: "user_01QA" }],
    ["a missing cap", { QA_SPEND_CAP_DOLLARS: undefined }],
    ["a zero cap", { QA_SPEND_CAP_DOLLARS: "0" }],
    ["a negative cap", { QA_SPEND_CAP_DOLLARS: "-5" }],
    ["an unlimited cap", { QA_SPEND_CAP_DOLLARS: "Infinity" }],
    ["an exponent cap", { QA_SPEND_CAP_DOLLARS: "1e9" }],
    ["a non-numeric cap", { QA_SPEND_CAP_DOLLARS: "unlimited" }],
    ["a malformed deny list", { QA_MONTHLY_QUOTA_DENY_USER_IDS: "*" }],
  ])("fails closed for %s", (_name, overrides) => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const env = { ...previewVercel, ...overrides };
    expect(getQaSpendPolicyStatus(env).status).toBe("misconfigured");
    expect(resolveQaSpendPool(QA_USER, "pro", env)).toBeNull();
    // Warnings name the problem without leaking configured identities.
    for (const [message] of warn.mock.calls) {
      expect(String(message)).not.toContain(QA_USER);
    }
    warn.mockRestore();
  });

  it("keeps listed billing fixtures on customer billing and disables the policy on overlap", () => {
    const withDenyList = {
      ...previewVercel,
      QA_MONTHLY_QUOTA_DENY_USER_IDS: BILLING_FIXTURE,
    };
    expect(resolveQaSpendPool(BILLING_FIXTURE, "pro", withDenyList)).toBeNull();
    expect(resolveQaSpendPool(QA_USER, "pro", withDenyList)).not.toBeNull();

    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const overlap = {
      ...withDenyList,
      QA_MONTHLY_QUOTA_USER_IDS: `${QA_USER},${BILLING_FIXTURE}`,
    };
    expect(getQaSpendPolicyStatus(overlap)).toEqual({
      status: "misconfigured",
      reason: "allow_deny_overlap",
    });
    expect(resolveQaSpendPool(QA_USER, "pro", overlap)).toBeNull();
    expect(resolveQaSpendPool(BILLING_FIXTURE, "pro", overlap)).toBeNull();
    warn.mockRestore();
  });
});
