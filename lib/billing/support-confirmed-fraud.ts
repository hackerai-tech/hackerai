type ChargeSnapshot = {
  id: string;
  customer: string | { id: string } | null;
  amount: number;
  currency: string;
  disputed: boolean;
  refunded: boolean;
};

type CustomerUserResolution = {
  userIds: string[];
  orgId: string | null;
  reason?: string;
};

export type SupportConfirmedFraudInput = {
  chargeId: string;
  customerId: string;
  userId: string;
  caseId: string;
};

export type SupportConfirmedFraudSuspensionPlan = {
  category: "support_confirmed_fraud";
  source: "support";
  sourceId: string;
  sourceReason: "confirmed_unauthorized_charge";
  sourceCreatedAt: number;
  userId: string;
  stripeCustomerId: string;
  stripeChargeId: string;
  workosOrganizationId: string;
  chargeAmount: number;
  chargeCurrency: string;
  chargeDisputed: boolean;
  chargeRefunded: boolean;
};

type PlanDependencies = {
  retrieveCharge: (chargeId: string) => Promise<ChargeSnapshot>;
  resolveCustomerUsers: (customerId: string) => Promise<CustomerUserResolution>;
  now?: () => number;
};

type SuspensionMutationArgs = Omit<
  SupportConfirmedFraudSuspensionPlan,
  "chargeAmount" | "chargeCurrency" | "chargeDisputed" | "chargeRefunded"
>;

type ApplyDependencies<Result> = {
  upsertActive: (args: SuspensionMutationArgs) => Promise<Result>;
};

const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requirePrefixedId(name: string, value: string, prefix: string) {
  if (!value.startsWith(prefix) || value.length === prefix.length) {
    throw new Error(`${name} must start with ${prefix}`);
  }
}

function requireValidInput(input: SupportConfirmedFraudInput) {
  requirePrefixedId("chargeId", input.chargeId, "ch_");
  requirePrefixedId("customerId", input.customerId, "cus_");
  requirePrefixedId("userId", input.userId, "user_");
  if (!CASE_ID_PATTERN.test(input.caseId)) {
    throw new Error(
      "caseId must be 1-128 characters using letters, numbers, dots, colons, underscores, or hyphens",
    );
  }
}

function chargeCustomerId(charge: ChargeSnapshot): string | null {
  return typeof charge.customer === "string"
    ? charge.customer
    : (charge.customer?.id ?? null);
}

export async function buildSupportConfirmedFraudSuspensionPlan(
  input: SupportConfirmedFraudInput,
  dependencies: PlanDependencies,
): Promise<SupportConfirmedFraudSuspensionPlan> {
  requireValidInput(input);

  const charge = await dependencies.retrieveCharge(input.chargeId);
  if (charge.id !== input.chargeId) {
    throw new Error(
      `Retrieved charge ${charge.id} does not match requested charge ${input.chargeId}`,
    );
  }

  const actualCustomerId = chargeCustomerId(charge);
  if (actualCustomerId !== input.customerId) {
    throw new Error(
      `Charge ${input.chargeId} does not belong to customer ${input.customerId}`,
    );
  }

  const resolution = await dependencies.resolveCustomerUsers(input.customerId);
  if (!resolution.userIds.includes(input.userId)) {
    const detail = resolution.reason ? ` (${resolution.reason})` : "";
    throw new Error(
      `User ${input.userId} is not an active member of customer ${input.customerId}${detail}`,
    );
  }
  if (!resolution.orgId) {
    throw new Error(
      `Customer ${input.customerId} has no verified WorkOS organization mapping`,
    );
  }

  return {
    category: "support_confirmed_fraud",
    source: "support",
    sourceId: `support_case:${input.caseId}`,
    sourceReason: "confirmed_unauthorized_charge",
    sourceCreatedAt: (dependencies.now ?? Date.now)(),
    userId: input.userId,
    stripeCustomerId: input.customerId,
    stripeChargeId: input.chargeId,
    workosOrganizationId: resolution.orgId,
    chargeAmount: charge.amount,
    chargeCurrency: charge.currency,
    chargeDisputed: charge.disputed,
    chargeRefunded: charge.refunded,
  };
}

export async function applySupportConfirmedFraudSuspension<Result>(
  plan: SupportConfirmedFraudSuspensionPlan,
  dependencies: ApplyDependencies<Result>,
): Promise<Result> {
  const {
    chargeAmount: _chargeAmount,
    chargeCurrency: _chargeCurrency,
    chargeDisputed: _chargeDisputed,
    chargeRefunded: _chargeRefunded,
    ...suspension
  } = plan;

  return await dependencies.upsertActive(suspension);
}
