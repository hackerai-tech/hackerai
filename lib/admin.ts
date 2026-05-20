export function adminUserIds(): Set<string> {
  return new Set(
    (process.env.ADMIN_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function isAdminUserId(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return adminUserIds().has(userId);
}
