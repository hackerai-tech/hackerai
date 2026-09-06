/**
 * Reload the current page with the `refresh=entitlements` hint so GlobalState
 * re-reads the WorkOS session after a server-side plan change (resume, migrate).
 */
export function reloadWithEntitlementRefresh(): void {
  if (typeof window === "undefined") return;

  try {
    const url = new URL(window.location.href);
    url.searchParams.set("refresh", "entitlements");
    window.location.replace(url.toString());
  } catch {
    window.location.reload();
  }
}
