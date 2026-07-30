type TokenizedFile = { tokens?: number };

export type InputTokenLimitStatus =
  { exceedsLimit: false } | { exceedsLimit: true; tokenCount: number };

export const inputTokenCountCouldExceedLimit = (
  input: string,
  uploadedFiles: TokenizedFile[],
  maxTokens: number,
): boolean => {
  const fileTokens = uploadedFiles.reduce(
    (total, file) => total + (file.tokens || 0),
    0,
  );
  const textByteUpperBound = new TextEncoder().encode(input).byteLength;

  return fileTokens + textByteUpperBound > maxTokens;
};

/**
 * Checks common inputs without loading the browser tokenizer. A BPE token
 * represents at least one UTF-8 byte, so an input whose total UTF-8 byte count
 * fits the token budget cannot exceed that budget. Inputs near the limit still
 * use the exact tokenizer to preserve existing validation behavior.
 */
export const getInputTokenLimitStatus = async (
  input: string,
  uploadedFiles: TokenizedFile[],
  maxTokens: number,
): Promise<InputTokenLimitStatus> => {
  if (!inputTokenCountCouldExceedLimit(input, uploadedFiles, maxTokens)) {
    return { exceedsLimit: false };
  }

  const { countInputTokens } = await import("@/lib/token-utils");
  const tokenCount = countInputTokens(input, uploadedFiles);

  return tokenCount > maxTokens
    ? { exceedsLimit: true, tokenCount }
    : { exceedsLimit: false };
};
