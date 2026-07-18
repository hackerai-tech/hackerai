interface PreviewEnvironment {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
}

export function canViewSidebarProjectIconPreview(
  environment: PreviewEnvironment = process.env,
): boolean {
  return (
    environment.NODE_ENV === "development" ||
    environment.VERCEL_ENV === "preview"
  );
}
