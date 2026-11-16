import type Stripe from "stripe";
import type { PostHog } from "posthog-node";
import { v5 as uuidv5 } from "uuid";

import { stripe } from "@/app/api/stripe";
import { workos } from "@/app/api/workos";
import PostHogClient from "@/app/posthog";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  PRO_MONTHLY_49_PRICE_LOOKUP_KEY,
  PRO_MONTHLY_PRICE_LOOKUP_KEY,
  isCurrentProMonthlyPrice,
  isProMonthly49Price,
  proMonthlyPricePresentation,
  stripePriceProductId,
} from "@/lib/pricing/pro-monthly";
import {
  HAC248_ENROLLED_EVENT,
  HAC248_PRO_MONTHLY_PRICING_KEY,
  HAC248_VARIANT_PRICES,
  hac248Properties,
  hac248QuoteForAssignment,
  parseHac248Assignment,
  type Hac248Assignment,
  type Hac248Variant,
  type ProMonthlyQuote,
} from "./pro-monthly-pricing-hac248";

type ListResult<T> = { data: T[]; has_more?: boolean };

/** Narrow client shapes so tests can supply fakes for each external boundary. */
export type Hac248Deps = {
  redis: {
    get(key: string): Promise<unknown>;
    set(key: string, value: string, options: { nx: true }): Promise<unknown>;
  } | null;
  posthog: Pick<PostHog, "getFeatureFlagResult" | "capture" | "flush"> | null;
  stripe: {
    prices: {
      list(params: Stripe.PriceListParams): Promise<ListResult<Stripe.Price>>;
      retrieve(id: string): Promise<Stripe.Price>;
    };
    customers: {
      list(
        params: Stripe.CustomerListParams,
      ): Promise<ListResult<{ id: string }>>;
    };
    subscriptions: {
      list(params: Stripe.SubscriptionListParams): Promise<ListResult<unknown>>;
    };
  };
  workos: {
    userManagement: {
      getUser(userId: string): Promise<{ email?: string; createdAt?: string }>;
      listOrganizationMemberships(options: {
        userId: string;
        statuses: Array<"active" | "inactive" | "pending">;
        limit: number;
      }): Promise<{
        data: Array<{ organizationId: string }>;
        listMetadata?: { after?: string | null };
      }>;
    };
    organizations: {
      getOrganization(
        organizationId: string,
      ): Promise<{ stripeCustomerId?: string | null }>;
    };
  };
  now: () => Date;
};

function defaultDeps(): Hac248Deps {
  return {
    redis: createRedisClient(),
    posthog: PostHogClient(),
    stripe: stripe as unknown as Hac248Deps["stripe"],
    workos: workos as unknown as Hac248Deps["workos"],
    now: () => new Date(),
  };
}

export class ProMonthlyPriceUnavailableError extends Error {
  constructor(readonly reason: string) {
    super("Pro monthly price is unavailable");
    this.name = "ProMonthlyPriceUnavailableError";
  }
}

export type ResolvedProMonthlyQuote = ProMonthlyQuote & {
  /** The validated Stripe Price that checkout must charge. */
  stripePrice: Stripe.Price;
};

export function hac248AssignmentStorageKey(userId: string): string {
  return `hac248:pro-monthly:${userId}`;
}

const MAX_MEMBERSHIPS = 100;
const MAX_EMAIL_CUSTOMERS = 10;
const TELEMETRY_FLUSH_TIMEOUT_MS = 750;

async function resolveControlPrice(deps: Hac248Deps): Promise<Stripe.Price> {
  let prices: ListResult<Stripe.Price>;
  try {
    prices = await deps.stripe.prices.list({
      lookup_keys: [PRO_MONTHLY_PRICE_LOOKUP_KEY],
    });
  } catch {
    throw new ProMonthlyPriceUnavailableError("control_price_lookup_failed");
  }
  const price = prices.data.find(
    (candidate) => candidate.lookup_key === PRO_MONTHLY_PRICE_LOOKUP_KEY,
  );
  if (!price || !isCurrentProMonthlyPrice(price)) {
    throw new ProMonthlyPriceUnavailableError("control_price_invalid");
  }
  return price;
}

/**
 * Read the durable assignment. Storage failure or a corrupt record stops the
 * quote; it must never fall through to a fresh assignment.
 */
export async function readStoredHac248Assignment(
  userId: string,
  deps: Hac248Deps = defaultDeps(),
): Promise<Hac248Assignment | undefined> {
  if (!deps.redis) {
    throw new ProMonthlyPriceUnavailableError("assignment_storage_unavailable");
  }
  let raw: unknown;
  try {
    raw = await deps.redis.get(hac248AssignmentStorageKey(userId));
  } catch {
    throw new ProMonthlyPriceUnavailableError("assignment_storage_unavailable");
  }
  if (raw === null || raw === undefined) return undefined;
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ProMonthlyPriceUnavailableError("assignment_corrupt");
    }
  }
  const assignment = parseHac248Assignment(value);
  if (!assignment) {
    throw new ProMonthlyPriceUnavailableError("assignment_corrupt");
  }
  return assignment;
}

async function stripePriceForAssignment(
  deps: Hac248Deps,
  assignment: Hac248Assignment,
  controlPrice: Stripe.Price,
  knownTestPrice?: Stripe.Price,
): Promise<Stripe.Price> {
  if (assignment.variant === "control") {
    // The quoted control Price is immutable; a moved lookup needs review.
    if (assignment.stripePriceId !== controlPrice.id) {
      throw new ProMonthlyPriceUnavailableError("assigned_price_changed");
    }
    return controlPrice;
  }
  let price = knownTestPrice;
  if (price?.id !== assignment.stripePriceId) {
    try {
      price = await deps.stripe.prices.retrieve(assignment.stripePriceId);
    } catch {
      throw new ProMonthlyPriceUnavailableError("assigned_price_lookup_failed");
    }
  }
  if (
    price.id !== assignment.stripePriceId ||
    !isProMonthly49Price(price, stripePriceProductId(controlPrice))
  ) {
    throw new ProMonthlyPriceUnavailableError("assigned_price_invalid");
  }
  return price;
}

type EnrollmentConfig = { variant: Hac248Variant; enrollmentStartAtMs: number };

function parseEnrollmentPayload(payload: unknown): number | undefined {
  let value = payload;
  if (typeof payload === "string") {
    try {
      value = JSON.parse(payload);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) return undefined;
  const start = candidate.enrollmentStartAt;
  if (typeof start !== "string") return undefined;
  const startMs = Date.parse(start);
  return Number.isFinite(startMs) ? startMs : undefined;
}

async function enrollmentConfig(
  deps: Hac248Deps,
  userId: string,
): Promise<EnrollmentConfig | undefined> {
  if (!deps.posthog) return undefined;
  // Evaluation is not exposure; exposure is captured when a quote renders.
  const result = await deps.posthog.getFeatureFlagResult(
    HAC248_PRO_MONTHLY_PRICING_KEY,
    userId,
    { sendFeatureFlagEvents: false },
  );
  if (!result?.enabled) return undefined;
  const variant =
    result.variant === "control" || result.variant === "test"
      ? result.variant
      : undefined;
  const enrollmentStartAtMs = parseEnrollmentPayload(result.payload);
  if (!variant || enrollmentStartAtMs === undefined) return undefined;
  return { variant, enrollmentStartAtMs };
}

/**
 * True only when every billing account reachable from this user verifiably has
 * no subscription or trial history. Truncated listings count as history.
 */
async function hasNoBillingHistory(
  deps: Hac248Deps,
  userId: string,
  email: string | undefined,
): Promise<boolean> {
  const memberships =
    await deps.workos.userManagement.listOrganizationMemberships({
      userId,
      statuses: ["active", "inactive", "pending"],
      limit: MAX_MEMBERSHIPS,
    });
  if (memberships.listMetadata?.after) return false;

  const customerIds = new Set<string>();
  for (const membership of memberships.data) {
    const organization = await deps.workos.organizations.getOrganization(
      membership.organizationId,
    );
    if (organization.stripeCustomerId) {
      customerIds.add(organization.stripeCustomerId);
    }
  }
  if (email) {
    const customers = await deps.stripe.customers.list({
      email,
      limit: MAX_EMAIL_CUSTOMERS,
    });
    if (customers.has_more) return false;
    for (const customer of customers.data) customerIds.add(customer.id);
  }

  for (const customerId of customerIds) {
    const subscriptions = await deps.stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 1,
    });
    if (subscriptions.data.length > 0) return false;
  }
  return true;
}

type EnrollmentCandidate = {
  assignment: Hac248Assignment;
  testPrice: Stripe.Price;
};

async function newEnrollmentCandidate(
  deps: Hac248Deps,
  userId: string,
  controlPrice: Stripe.Price,
): Promise<EnrollmentCandidate | undefined> {
  try {
    const config = await enrollmentConfig(deps, userId);
    if (!config) return undefined;

    const user = await deps.workos.userManagement.getUser(userId);
    const createdAtMs =
      typeof user.createdAt === "string" ? Date.parse(user.createdAt) : NaN;
    if (
      !Number.isFinite(createdAtMs) ||
      createdAtMs < config.enrollmentStartAtMs
    ) {
      return undefined;
    }

    // Both arms need a sellable $49 Price so enrollment stays balanced.
    const testPrices = await deps.stripe.prices.list({
      active: true,
      lookup_keys: [PRO_MONTHLY_49_PRICE_LOOKUP_KEY],
    });
    const testPrice = testPrices.data.find((price) =>
      isProMonthly49Price(price, stripePriceProductId(controlPrice)),
    );
    if (!testPrice) return undefined;

    if (!(await hasNoBillingHistory(deps, userId, user.email))) {
      return undefined;
    }

    const prices = HAC248_VARIANT_PRICES[config.variant];
    return {
      testPrice,
      assignment: {
        version: 1,
        key: HAC248_PRO_MONTHLY_PRICING_KEY,
        variant: config.variant,
        priceLookupKey: prices.priceLookupKey,
        displayedAmountDollars: prices.displayedAmountDollars,
        stripePriceId:
          config.variant === "test" ? testPrice.id : controlPrice.id,
        assignedAt: deps.now().toISOString(),
      },
    };
  } catch {
    // Incomplete eligibility evidence keeps the account on the current price.
    return undefined;
  }
}

/**
 * Best-effort enrollment event. It is re-sent on every resolution of a stored
 * assignment with the same deterministic UUID and original timestamp, so a
 * failed first delivery is retried later and PostHog deduplicates repeats.
 * Telemetry failure never changes the quote.
 */
async function captureEnrollment(
  deps: Hac248Deps,
  userId: string,
  assignment: Hac248Assignment,
) {
  const posthog = deps.posthog;
  if (!posthog) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    posthog.capture({
      distinctId: userId,
      event: HAC248_ENROLLED_EVENT,
      uuid: uuidv5(`${HAC248_ENROLLED_EVENT}:${userId}`, uuidv5.URL),
      timestamp: new Date(assignment.assignedAt),
      properties: {
        ...hac248Properties(assignment),
        $geoip_disable: true,
      },
    });
    await Promise.race([
      posthog.flush(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, TELEMETRY_FLUSH_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Telemetry must not change the quote.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Authoritative monthly Pro quote for an authenticated account.
 *
 * A stored assignment always wins, even with enrollment disabled. Without
 * one, `enroll` permits a new assignment only for an eligible new free
 * account. Everything else is quoted the current $29 Price.
 */
export async function resolveProMonthlyQuote({
  userId,
  subscription,
  enroll,
  deps = defaultDeps(),
}: {
  userId: string;
  subscription: string;
  enroll: boolean;
  deps?: Hac248Deps;
}): Promise<ResolvedProMonthlyQuote> {
  const controlPrice = await resolveControlPrice(deps);
  const existing = await readStoredHac248Assignment(userId, deps);
  if (existing) {
    const stripePrice = await stripePriceForAssignment(
      deps,
      existing,
      controlPrice,
    );
    // Retries an enrollment event whose first delivery may have failed.
    await captureEnrollment(deps, userId, existing);
    return {
      price: hac248QuoteForAssignment(existing),
      assignment: existing,
      stripePrice,
    };
  }

  const current: ResolvedProMonthlyQuote = {
    price: proMonthlyPricePresentation(controlPrice),
    stripePrice: controlPrice,
  };
  if (!enroll || subscription !== "free") return current;

  const candidate = await newEnrollmentCandidate(deps, userId, controlPrice);
  if (!candidate) return current;

  let written: unknown;
  try {
    written = await deps.redis!.set(
      hac248AssignmentStorageKey(userId),
      JSON.stringify(candidate.assignment),
      { nx: true },
    );
  } catch {
    throw new ProMonthlyPriceUnavailableError("assignment_storage_unavailable");
  }

  let assignment = candidate.assignment;
  if (written !== "OK") {
    // Another request enrolled this account first; its assignment wins.
    const winner = await readStoredHac248Assignment(userId, deps);
    if (!winner) {
      throw new ProMonthlyPriceUnavailableError("assignment_race_unresolved");
    }
    assignment = winner;
  }

  const stripePrice = await stripePriceForAssignment(
    deps,
    assignment,
    controlPrice,
    candidate.testPrice,
  );
  // The winner's original event; a duplicate from the other request dedupes.
  await captureEnrollment(deps, userId, assignment);
  return {
    price: hac248QuoteForAssignment(assignment),
    assignment,
    stripePrice,
  };
}
