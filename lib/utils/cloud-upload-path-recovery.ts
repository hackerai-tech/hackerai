import "server-only";

import { randomUUID } from "node:crypto";
import type { AnySandbox } from "@/types";
import { runAttachmentCommand } from "@/lib/ai/tools/utils/attachment-command";

const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Reserve a private staging directory for one cloud attachment whose intended
 * destination is not writable.
 *
 * A reused workspace can hold a `hackerai-upload` root that the command user
 * cannot write, in every candidate base at once. The reservation therefore
 * never depends on, alters or removes an existing path: it creates a fresh
 * owner-only directory directly beneath the first base that accepts it.
 * Returns null when no base qualifies; a nonzero exit keeps the adapter's
 * existing rejection so the caller can preserve the original transfer error.
 */
export async function reserveCloudUploadFallbackPath(
  sandbox: AnySandbox,
  originalLocalPath: string,
  signal?: AbortSignal,
  requireFreeSpace = false,
): Promise<string | null> {
  signal?.throwIfAborted();
  const fileName = originalLocalPath.split(/[/\\]/).pop();
  if (!fileName) return null;
  const directoryName = `hackerai-upload-${randomUUID()}`;

  const script = [
    `filename=${shellQuote(fileName)}`,
    `name=${shellQuote(directoryName)}`,
    `for base in "\${TMPDIR:-/tmp}" /var/tmp "\${HOME:-}" "\${PWD:-.}"; do`,
    `  [ -n "$base" ] || continue`,
    `  base="$(cd -- "$base" 2>/dev/null && pwd -P)" || continue`,
    ...(requireFreeSpace
      ? [
          `  df -Pk "$base" 2>/dev/null | awk 'NR > 1 && $4 > 0 { free = 1 } END { exit !free }' || continue`,
        ]
      : []),
    // mkdir without -p fails on any existing entry, including a symlink, so
    // success proves this command created the directory it reports.
    `  dir="\${base%/}/$name"`,
    `  mkdir -m 700 -- "$dir" 2>/dev/null || continue`,
    `  printf '%s/%s\\n' "$dir" "$filename"`,
    `  exit 0`,
    `done`,
    `exit 1`,
  ].join("\n");

  const result = await runAttachmentCommand(sandbox, script, signal);
  signal?.throwIfAborted();
  if (result.exitCode !== 0) return null;
  // Commands run in a login shell whose profile may write to stdout. Accept
  // only the line naming the directory reserved by this call.
  const suffix = `/${directoryName}/${fileName}`;
  return (
    result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("/") && line.endsWith(suffix)) ?? null
  );
}
