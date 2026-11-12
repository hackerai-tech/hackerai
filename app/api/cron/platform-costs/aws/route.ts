import { NextResponse } from "next/server";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import { fetchAwsCostWindow } from "@/lib/billing/aws-costs";
import { completedUtcDayWindow } from "@/lib/billing/platform-costs";
import {
  isAuthorizedCronRequest,
  logCostSync,
  replaceCostWindow,
  requireEnvironment,
} from "@/lib/billing/platform-cost-sync";

export const runtime = "nodejs";
export const maxDuration = 120;

function failureCode(error: unknown): string {
  if (!(error instanceof Error)) return "redacted";
  const names = [
    "AccessDenied",
    "AccessDeniedException",
    "InvalidIdentityToken",
    "InvalidIdentityTokenException",
    "IDPRejectedClaim",
    "ExpiredToken",
    "ExpiredTokenException",
    "ValidationException",
    "DataUnavailableException",
    "VercelOidcTokenError",
  ];
  if (names.includes(error.name)) return error.name;
  const messages: Record<string, string> = {
    "Invalid AWS cost reader scope": "configuration_scope",
    "AWS caller differs from the approved cost role": "caller_mismatch",
    "Unexpected AWS cost dimensions or result shape": "provider_dimensions",
    "Invalid AWS daily cost period": "provider_period",
    "AWS cost amount or currency is unknown": "provider_amount",
    "AWS cost response has missing days": "provider_days",
    "AWS Marketplace charges require vendor reconciliation":
      "marketplace_reconciliation",
    "Duplicate AWS service/day charge": "provider_duplicate",
  };
  return Object.hasOwn(messages, error.message)
    ? messages[error.message]
    : "redacted";
}

/** Account overhead only; never used to settle customer usage or wallets. */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (
    process.env.VERCEL_ENV !== "production" ||
    !process.env.AWS_COST_ROLE_ARN ||
    !process.env.AWS_COST_ACCOUNT_ID
  )
    return NextResponse.json(
      { error: "AWS cost reader not configured" },
      { status: 503 },
    );
  let sts: STSClient | undefined;
  let costs: CostExplorerClient | undefined;
  let phase = "configuration";
  try {
    const accountId = requireEnvironment("AWS_COST_ACCOUNT_ID");
    const roleArn = requireEnvironment("AWS_COST_ROLE_ARN");
    const role =
      /^arn:aws:iam::(\d{12}):role\/([A-Za-z0-9+=,.@_-]{1,64})$/.exec(roleArn);
    if (!role || role[1] !== accountId)
      throw new Error("Invalid AWS cost reader scope");
    // Use the deployment's existing audience. A custom audience invokes another
    // token-exchange endpoint; it is unnecessary when IAM already trusts the
    // verified default issuer/audience/Production subject.
    phase = "identity";
    const credentials = awsCredentialsProvider({
      roleArn,
      durationSeconds: 900,
      clientConfig: { region: "us-east-1" },
    });
    sts = new STSClient({ region: "us-east-1", credentials, maxAttempts: 3 });
    const identity = await sts.send(new GetCallerIdentityCommand({}), {
      abortSignal: AbortSignal.timeout(30_000),
    });
    if (
      identity.Account !== accountId ||
      !identity.Arn?.startsWith(
        `arn:aws:sts::${accountId}:assumed-role/${role[2]}/`,
      )
    )
      throw new Error("AWS caller differs from the approved cost role");
    const observedAt = Date.now();
    const window = completedUtcDayWindow(observedAt, 35);
    costs = new CostExplorerClient({
      region: "us-east-1",
      credentials,
      maxAttempts: 3,
    });
    phase = "cost_read";
    const rows = await fetchAwsCostWindow(
      costs,
      accountId,
      window.startDay,
      window.endDay,
    );
    phase = "persist";
    const result = await replaceCostWindow({
      vendor: "aws",
      startDay: window.startDay,
      endDay: window.endDay,
      observedAt,
      rows,
    });
    logCostSync("info", "platform_cost_sync_completed", {
      vendor: "aws",
      row_count: rows.length,
      ...result,
    });
    return NextResponse.json({ ok: true, rowCount: rows.length, ...result });
  } catch (error) {
    // STS/provider errors can contain signed requests and credentials.
    logCostSync("error", "platform_cost_sync_failed", {
      vendor: "aws",
      phase,
      failure_code: failureCode(error),
    });
    return NextResponse.json({ error: "Cost sync failed" }, { status: 500 });
  } finally {
    sts?.destroy();
    costs?.destroy();
  }
}
