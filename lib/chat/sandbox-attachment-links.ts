import type { FileDetails } from "@/types/file";

/**
 * Assistant Markdown can name a delivered artifact as `sandbox:/path`. The
 * Markdown sanitizer drops that scheme, so a remark step rewrites validated
 * links to this inert fragment before sanitization. The fragment carries only
 * the path: download access comes from this message's delivery receipts and
 * authorized file metadata, never from the link text itself.
 */
export const SANDBOX_ATTACHMENT_HREF_PREFIX = "#hackerai-sandbox-file=";

const SANDBOX_SCHEME = "sandbox:";
const MAX_SANDBOX_PATH_LENGTH = 4096;

/** Accept only a normalized absolute POSIX path without traversal segments. */
function isSafeAbsolutePath(path: string): boolean {
  if (path.length > MAX_SANDBOX_PATH_LENGTH || !path.startsWith("/")) {
    return false;
  }
  // Control characters and backslashes have no place in a delivered path and
  // could hide separators from the segment check below.
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return false;
  }
  return path
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function decodePath(encoded: string): string | null {
  try {
    const decoded = decodeURIComponent(encoded);
    return isSafeAbsolutePath(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Parse `sandbox:/abs/path`; authority, query, fragment and traversal forms fail. */
export function parseSandboxLinkPath(url: unknown): string | null {
  if (typeof url !== "string" || !url.startsWith(SANDBOX_SCHEME)) return null;
  const encoded = url.slice(SANDBOX_SCHEME.length);
  if (!encoded.startsWith("/") || /[?#]/.test(encoded)) return null;
  return decodePath(encoded);
}

export function toSandboxAttachmentHref(path: string): string {
  // Keep the fragment byte-for-byte stable through URL normalization.
  return `${SANDBOX_ATTACHMENT_HREF_PREFIX}${encodeURIComponent(path).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )}`;
}

export function parseSandboxAttachmentHref(href: unknown): string | null {
  if (
    typeof href !== "string" ||
    !href.startsWith(SANDBOX_ATTACHMENT_HREF_PREFIX)
  ) {
    return null;
  }
  return decodePath(href.slice(SANDBOX_ATTACHMENT_HREF_PREFIX.length));
}

/** Cheap prefilter for text parts whose rendering depends on receipts. */
export function mayContainSandboxAttachmentLink(text: unknown): boolean {
  return (
    typeof text === "string" &&
    (text.includes(SANDBOX_SCHEME) ||
      text.includes(SANDBOX_ATTACHMENT_HREF_PREFIX))
  );
}

interface MarkdownNode {
  type: string;
  url?: unknown;
  children?: unknown;
}

function rewriteSandboxLinks(node: MarkdownNode): void {
  if (node.type === "link") {
    const path = parseSandboxLinkPath(node.url);
    if (path) node.url = toSandboxAttachmentHref(path);
  }
  // Images, code, inline code, raw HTML and reference definitions are not
  // `link` nodes, so their URLs stay subject to the default sanitizers.
  if (Array.isArray(node.children)) {
    for (const child of node.children as MarkdownNode[]) {
      rewriteSandboxLinks(child);
    }
  }
}

/** Remark plugin: rewrite validated `sandbox:` link destinations only. */
export function remarkSandboxAttachmentLinks() {
  return (tree: MarkdownNode) => rewriteSandboxLinks(tree);
}

export interface SandboxDeliveryReceipt {
  fileId: string;
  sourcePath: string;
}

/** Read stored receipts from completed get_terminal_files calls in one message. */
export function collectSandboxDeliveryReceipts(
  parts: readonly unknown[] | undefined,
): SandboxDeliveryReceipt[] {
  const receipts: SandboxDeliveryReceipt[] = [];
  for (const part of parts ?? []) {
    const candidate = part as {
      type?: unknown;
      state?: unknown;
      output?: { deliveryReceipts?: unknown };
    } | null;
    if (
      candidate?.type !== "tool-get_terminal_files" ||
      candidate.state !== "output-available" ||
      !Array.isArray(candidate.output?.deliveryReceipts)
    ) {
      continue;
    }
    for (const receipt of candidate.output.deliveryReceipts) {
      const { fileId, sourcePath, storageStatus } = (receipt ?? {}) as {
        fileId?: unknown;
        sourcePath?: unknown;
        storageStatus?: unknown;
      };
      if (
        storageStatus === "stored" &&
        typeof fileId === "string" &&
        fileId !== "" &&
        typeof sourcePath === "string"
      ) {
        receipts.push({ fileId, sourcePath });
      }
    }
  }
  return receipts;
}

/** Stable comparison key for memoized text parts. */
export function sandboxDeliveryReceiptSignature(
  parts: readonly unknown[] | undefined,
): string {
  return collectSandboxDeliveryReceipts(parts)
    .map(({ fileId, sourcePath }) => `${fileId}\u0000${sourcePath}`)
    .join("\u0001");
}

/**
 * Map exact delivered source paths to this message's authorized file metadata.
 * A path delivered as more than one file is ambiguous and stays unresolved.
 */
export function resolveSandboxAttachments(
  parts: readonly unknown[] | undefined,
  fileDetails: readonly FileDetails[] | undefined,
): ReadonlyMap<string, FileDetails> {
  const resolved = new Map<string, FileDetails>();
  if (!fileDetails?.length) return resolved;

  const fileIdsByPath = new Map<string, Set<string>>();
  for (const { fileId, sourcePath } of collectSandboxDeliveryReceipts(parts)) {
    if (!isSafeAbsolutePath(sourcePath)) continue;
    const fileIds = fileIdsByPath.get(sourcePath) ?? new Set<string>();
    fileIds.add(fileId);
    fileIdsByPath.set(sourcePath, fileIds);
  }

  for (const [sourcePath, fileIds] of fileIdsByPath) {
    if (fileIds.size !== 1) continue;
    const [fileId] = fileIds;
    const file = fileDetails.find((candidate) => candidate.fileId === fileId);
    if (file) resolved.set(sourcePath, file);
  }
  return resolved;
}
