import { createHash } from "node:crypto";
import type { E2BCluster } from "../ai/tools/utils/e2b-cluster";

// Identity of one automated egress review case. Shared by the Trigger review
// and the Convex reassessment action, which rebinds a stored record to the
// reference and digest it was saved under. Relative imports only: Convex
// bundles this module.

export const REVIEW_WINDOW_MINUTES = 30;

export const reviewWindowStart = (minute: number) =>
  Math.floor(minute / REVIEW_WINDOW_MINUTES) * REVIEW_WINDOW_MINUTES;

/** One case per owner reference, region and 30-minute UTC window. */
export function reviewCaseKey(
  region: E2BCluster,
  owner: string,
  windowStart: number,
) {
  return `egress-abuse-review:v1:${region}:${owner}:${windowStart}`;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** A stable `AB-` reference in the existing case format, derived from the key. */
export function reviewReference(caseKey: string) {
  const hex = sha256(`reference\n${caseKey}`);
  return `AB-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const reviewDigest = (caseKey: string) => sha256(`digest\n${caseKey}`);
