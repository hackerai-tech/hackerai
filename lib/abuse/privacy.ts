export function isAbuseReportingPath(path: string): boolean {
  return (
    path === "/abuse" ||
    path.startsWith("/abuse/") ||
    path === "/api/abuse" ||
    path.startsWith("/api/internal/abuse")
  );
}

/** Also drop delayed exceptions whose recorded URL belongs to the reporting page. */
export function isAbuseTelemetry(
  currentPath: string,
  properties?: Record<string, unknown>,
): boolean {
  if (isAbuseReportingPath(currentPath)) return true;
  for (const key of ["$current_url", "$pathname", "$exception_url"]) {
    const value = properties?.[key];
    if (typeof value !== "string") continue;
    try {
      if (isAbuseReportingPath(new URL(value, "https://hackerai.co").pathname))
        return true;
    } catch {
      // Unparseable URLs do not authorize keeping an event from this page.
    }
  }
  return false;
}
