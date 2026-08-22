export const getExtraUsageReturnUrl = (
  origin: string,
  returnPath: string | undefined,
): URL => {
  const fallback = new URL(origin);

  if (
    !returnPath ||
    !returnPath.startsWith("/") ||
    returnPath.startsWith("//")
  ) {
    return fallback;
  }

  try {
    const returnUrl = new URL(returnPath, fallback);
    return returnUrl.origin === fallback.origin ? returnUrl : fallback;
  } catch {
    return fallback;
  }
};
