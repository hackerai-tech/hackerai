export const MAX_OUTPUT_TOKENS =
  process.env.NEXT_PUBLIC_SELF_HOSTED === "true" ? 2048 : 32_000;
