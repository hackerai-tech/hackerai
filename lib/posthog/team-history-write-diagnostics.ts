import {
  getIdentifiedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
} from "@/lib/analytics/client";

// Chosen for diagnosis; browsers do not expose their History budget or window.
const WINDOW_MS = 30000;
const MAX_WRITES = 128;
export type TeamHistoryWriteSite =
  "team_seat_sync" | "team_close_cleanup" | "pricing_team_open";
const SITES: readonly TeamHistoryWriteSite[] = [
  "team_seat_sync",
  "team_close_cleanup",
  "pricing_team_open",
];
type Write = { at: number; site: TeamHistoryWriteSite; sameUrl: boolean };
const writes: Array<Write | undefined> = new Array(MAX_WRITES);
let next = 0;
let owner: string | null = null;
let subscribed = false;

function clearWrites() {
  writes.fill(undefined);
  next = 0;
  owner = null;
}

function identifiedOwner() {
  if (!subscribed) {
    // Use the existing consent/identity notifications even when no write or
    // exception occurs during revocation. No DOM listener or timer is added.
    subscribeAuthenticatedAnalytics(clearWrites);
    subscribed = true;
  }
  const current = getIdentifiedAnalyticsUserId();
  if (current !== owner || !current) {
    clearWrites();
    owner = current;
  }
  return current;
}

/**
 * Call immediately before an instrumented Team `replaceState`. Never retains
 * the URL, its parameters, history state, or an error.
 */
export function recordTeamHistoryWrite(
  site: TeamHistoryWriteSite,
  sameUrl: boolean,
): void {
  try {
    if (!identifiedOwner() || !SITES.includes(site)) return;
    const at = performance.now();
    if (!Number.isFinite(at) || at < 0) return;
    writes[next] = { at, site, sameUrl: sameUrl === true };
    next = (next + 1) % MAX_WRITES;
  } catch {
    // Diagnostics must never prevent or replace the History write.
  }
}

/**
 * Capped recent attempts by the instrumented Team sites only. Other History
 * writers (including Next's router) share the browser budget but are not
 * counted, so these numbers never describe that budget.
 */
export function getTeamHistoryWriteDiagnostics(): Record<
  string,
  string | number | boolean
> {
  try {
    if (!identifiedOwner()) return {};
    const now = performance.now();
    if (!Number.isFinite(now) || now < 0) return {};
    const recent: Write[] = [];
    for (let i = 0; i < writes.length; i++) {
      const write = writes[i];
      if (!write) continue;
      const age = now - write.at;
      if (age < 0 || age >= WINDOW_MS) writes[i] = undefined;
      else recent.push(write);
    }
    const siteCount = (site: TeamHistoryWriteSite) =>
      recent.filter((write) => write.site === site).length;
    return {
      hackerai_team_history_write_version: 1,
      hackerai_team_history_write_scope: "instrumented_team_sites",
      hackerai_team_history_write_unit: "attempts",
      hackerai_team_history_write_window_ms: WINDOW_MS,
      hackerai_team_history_write_count: recent.length,
      hackerai_team_history_write_capped: recent.length >= MAX_WRITES,
      hackerai_team_history_write_same_url_count: recent.filter(
        (write) => write.sameUrl,
      ).length,
      hackerai_team_history_write_seat_sync_count: siteCount("team_seat_sync"),
      hackerai_team_history_write_close_cleanup_count:
        siteCount("team_close_cleanup"),
      hackerai_team_history_write_pricing_open_count:
        siteCount("pricing_team_open"),
    };
  } catch {
    return {};
  }
}
