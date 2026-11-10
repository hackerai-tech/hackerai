/** This public switch must be identical at build time and runtime. */
export const isSelfHosted = () =>
  process.env.NEXT_PUBLIC_SELF_HOSTED === "true";

export const LOCAL_ENTITLEMENTS = ["ultra-plan"];
