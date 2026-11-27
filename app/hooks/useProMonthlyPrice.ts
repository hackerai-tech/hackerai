"use client";

import { useCallback, useEffect } from "react";
import useSWR, { mutate as mutateGlobal } from "swr";
import { useAuth } from "@workos-inc/authkit-nextjs/components";

import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { PRICING } from "@/lib/pricing/config";
import {
  HAC248_EXPOSURE_EVENT,
  hac248Properties,
  parseProMonthlyQuote,
  type ProMonthlyQuote,
} from "@/lib/experiments/pro-monthly-pricing-hac248";

const PRICE_KEY = "pro-monthly-price";
export const PRO_MONTHLY_PRICE_TIMEOUT_MS = 10_000;

async function fetchProMonthlyQuote(): Promise<ProMonthlyQuote> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    PRO_MONTHLY_PRICE_TIMEOUT_MS,
  );
  try {
    const response = await fetch("/api/pricing/pro-monthly-experiment", {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Price unavailable");
    const quote = parseProMonthlyQuote(await response.json());
    if (!quote) throw new Error("Invalid price");
    return quote;
  } finally {
    clearTimeout(timeout);
  }
}

export type ProMonthlyPriceState =
  /** No account price applies yet: signed out, or sign-in still resolving. */
  | { status: "signed-out" }
  /** Signed in, but the caller has not asked for the price. */
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; quote: ProMonthlyQuote }
  | { status: "error" };

/**
 * The signed-in account's authoritative monthly Pro price. Pass `enabled`
 * only while a pricing surface is visible: resolving can enroll a new account.
 * The cache is keyed by user and organization, so a different account never
 * sees a previous account's price.
 */
export function useProMonthlyPrice(enabled: boolean): ProMonthlyPriceState & {
  retry: () => void;
} {
  const { user, organizationId, loading } = useAuth();
  const signedIn = Boolean(user) && !loading;
  const { data, error, isValidating, mutate } = useSWR(
    enabled && signedIn && user
      ? [PRICE_KEY, user.id, organizationId ?? null]
      : null,
    fetchProMonthlyQuote,
    {
      dedupingInterval: 60_000,
      refreshInterval: 0,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    },
  );
  const retry = useCallback(() => {
    void mutate();
  }, [mutate]);

  if (!signedIn) return { status: "signed-out", retry };
  if (!enabled) return { status: "idle", retry };
  if (data) return { status: "ready", quote: data, retry };
  if (error && !isValidating) return { status: "error", retry };
  return { status: "loading", retry };
}

/**
 * How the monthly Pro price reads. Until an account price resolves, never show
 * a definite amount: "From $29" signed out or on error, a placeholder while
 * loading.
 */
export function proMonthlyPriceDisplay(state: ProMonthlyPriceState): {
  price: number;
  prefix?: "From";
  loading?: true;
  status?: string;
} {
  switch (state.status) {
    case "ready":
      return { price: state.quote.price.displayedAmountDollars };
    case "loading":
    case "idle":
      return { price: PRICING.pro.monthly, loading: true };
    case "error":
      return {
        price: PRICING.pro.monthly,
        prefix: "From",
        status: "Couldn’t confirm your price.",
      };
    case "signed-out":
      return { price: PRICING.pro.monthly, prefix: "From" };
  }
}

/** Drop every cached account price, e.g. after checkout reports a change. */
export function invalidateProMonthlyPrice() {
  return mutateGlobal(
    (key) => Array.isArray(key) && key[0] === PRICE_KEY,
    undefined,
    { revalidate: true },
  );
}

const capturedExposures = new Set<string>();

/**
 * Record exposure only when an assigned monthly quote is actually on screen.
 * Fetching or evaluating the assignment is not exposure.
 */
export function useProMonthlyPriceExposure(
  quote: ProMonthlyQuote | undefined,
  surface: string,
  visible: boolean,
) {
  const assignment = quote?.assignment;
  useEffect(() => {
    if (!visible || !assignment) return;
    const key = `${assignment.stripePriceId}:${assignment.assignedAt}:${surface}`;
    if (capturedExposures.has(key)) return;
    let tries = 0;
    // Authenticated analytics may still be initializing; retry briefly.
    const capture = () => {
      tries += 1;
      if (capturedExposures.has(key)) return true;
      if (
        captureAuthenticatedEvent(HAC248_EXPOSURE_EVENT, {
          ...hac248Properties(assignment),
          exposure_surface: surface,
        })
      ) {
        capturedExposures.add(key);
        return true;
      }
      return tries >= 10;
    };
    if (capture()) return;
    const timer = setInterval(() => {
      if (capture()) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [assignment, surface, visible]);
}
