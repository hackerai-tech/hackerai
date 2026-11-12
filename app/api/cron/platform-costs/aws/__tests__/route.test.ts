/** @jest-environment node */
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { STSClient } from "@aws-sdk/client-sts";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import { GET } from "../route";
import {
  isAuthorizedCronRequest,
  logCostSync,
  replaceCostWindow,
} from "@/lib/billing/platform-cost-sync";

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  },
}));
jest.mock("@aws-sdk/client-cost-explorer", () => ({
  ...jest.requireActual("@aws-sdk/client-cost-explorer"),
  CostExplorerClient: jest.fn(),
}));
jest.mock("@aws-sdk/client-sts", () => ({
  ...jest.requireActual("@aws-sdk/client-sts"),
  STSClient: jest.fn(),
}));
jest.mock("@vercel/oidc-aws-credentials-provider", () => ({
  awsCredentialsProvider: jest.fn(),
}));
jest.mock("@/lib/billing/platform-cost-sync", () => ({
  isAuthorizedCronRequest: jest.fn(),
  replaceCostWindow: jest.fn(),
  logCostSync: jest.fn(),
  requireEnvironment: (name: string) => {
    if (!process.env[name]) throw new Error("Missing config");
    return process.env[name];
  },
}));

const original = { ...process.env };
const identity = jest.fn();
const costs = jest.fn();
const destroy = jest.fn();
const request = () =>
  new Request("https://example.test/api/cron/platform-costs/aws");
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date("2026-11-12T18:00:00Z"));
  process.env.VERCEL_ENV = "production";
  process.env.AWS_COST_ACCOUNT_ID = "123456789012";
  process.env.AWS_COST_ROLE_ARN = "arn:aws:iam::123456789012:role/CostReader";
  process.env.AWS_COST_OIDC_AUDIENCE = "https://vercel.com/example";
  jest.mocked(isAuthorizedCronRequest).mockReturnValue(true);
  jest
    .mocked(STSClient)
    .mockImplementation(
      () => ({ send: identity, destroy }) as unknown as STSClient,
    );
  jest
    .mocked(CostExplorerClient)
    .mockImplementation(
      () => ({ send: costs, destroy }) as unknown as CostExplorerClient,
    );
  identity.mockResolvedValue({
    Account: "123456789012",
    Arn: "arn:aws:sts::123456789012:assumed-role/CostReader/session",
  });
  jest
    .mocked(replaceCostWindow)
    .mockResolvedValue({ inserted: 35, updated: 0, deleted: 0, unchanged: 0 });
});
afterEach(() => {
  process.env = { ...original };
  jest.useRealTimers();
});

const complete = () => ({
  GroupDefinitions: [
    { Type: "DIMENSION", Key: "SERVICE" },
    { Type: "DIMENSION", Key: "RECORD_TYPE" },
  ],
  ResultsByTime: Array.from({ length: 35 }, (_, index) => ({
    TimePeriod: {
      Start: new Date(Date.UTC(2026, 9, 8 + index)).toISOString().slice(0, 10),
      End: new Date(Date.UTC(2026, 9, 9 + index)).toISOString().slice(0, 10),
    },
    Groups: [
      {
        Keys: ["Compute", "Usage"],
        Metrics: { UnblendedCost: { Amount: "1", Unit: "USD" } },
      },
    ],
  })),
});

const noMarketplace = () => ({
  ResultsByTime: complete().ResultsByTime.map((row) => ({
    TimePeriod: row.TimePeriod,
    Total: { UnblendedCost: { Amount: "0", Unit: "USD" } },
  })),
});

test("unauthorized, Preview and unconfigured calls cannot obtain AWS credentials", async () => {
  jest.mocked(isAuthorizedCronRequest).mockReturnValueOnce(false);
  expect((await GET(request())).status).toBe(401);
  process.env.VERCEL_ENV = "preview";
  expect((await GET(request())).status).toBe(503);
  process.env.VERCEL_ENV = "production";
  delete process.env.AWS_COST_ROLE_ARN;
  expect((await GET(request())).status).toBe(503);
  expect(awsCredentialsProvider).not.toHaveBeenCalled();
  expect(replaceCostWindow).not.toHaveBeenCalled();
});

test("wrong account or role identity stops before reading or storing cost data", async () => {
  identity.mockResolvedValueOnce({
    Account: "999999999999",
    Arn: "arn:aws:sts::999999999999:assumed-role/CostReader/session",
  });
  expect((await GET(request())).status).toBe(500);
  identity.mockResolvedValueOnce({
    Account: "123456789012",
    Arn: "arn:aws:sts::123456789012:assumed-role/OtherRole/session",
  });
  expect((await GET(request())).status).toBe(500);
  expect(costs).not.toHaveBeenCalled();
  expect(replaceCostWindow).not.toHaveBeenCalled();
});

test("a complete AWS response reaches the existing bounded replacement path", async () => {
  costs
    .mockResolvedValueOnce(noMarketplace())
    .mockResolvedValueOnce(complete());
  expect((await GET(request())).status).toBe(200);
  expect(awsCredentialsProvider).toHaveBeenCalledWith(
    expect.objectContaining({
      roleArn: process.env.AWS_COST_ROLE_ARN,
      audience: process.env.AWS_COST_OIDC_AUDIENCE,
      durationSeconds: 900,
    }),
  );
  expect(replaceCostWindow).toHaveBeenCalledWith(
    expect.objectContaining({
      vendor: "aws",
      startDay: "2026-10-08",
      endDay: "2026-11-11",
      rows: expect.arrayContaining([
        expect.objectContaining({
          costStatus: "estimated",
          effectiveCostDollars: 1,
        }),
      ]),
    }),
  );
  expect(jest.mocked(replaceCostWindow).mock.calls[0][0].rows).toHaveLength(35);
  expect(destroy).toHaveBeenCalledTimes(2);
});

test("failed pagination and incomplete daily data preserve stored costs and redact errors", async () => {
  costs
    .mockResolvedValueOnce(noMarketplace())
    .mockResolvedValueOnce({ ...complete(), NextPageToken: "next" })
    .mockRejectedValueOnce(new Error("Bearer private-provider-token"));
  const failed = await GET(request());
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain("private-provider-token");
  costs.mockResolvedValueOnce(noMarketplace()).mockResolvedValueOnce({
    ...complete(),
    ResultsByTime: complete().ResultsByTime.slice(1),
  });
  expect((await GET(request())).status).toBe(500);
  expect(replaceCostWindow).not.toHaveBeenCalled();
  expect(logCostSync).toHaveBeenCalledWith(
    "error",
    "platform_cost_sync_failed",
    { vendor: "aws" },
  );
});
