import type { UIMessageStreamWriter } from "ai";
import type { SandboxFallbackInfo } from "./hybrid-sandbox-manager";

type SandboxContextForPromptManager = {
  getSandboxInfo?: () => unknown;
  getSandboxContextForPrompt?: () => Promise<string | null>;
  consumeFallbackInfo?: () => SandboxFallbackInfo | null;
};

const escapePromptText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function writeSandboxFallbackEvent(
  writer: UIMessageStreamWriter,
  fallbackInfo: SandboxFallbackInfo,
  id: string,
): void {
  writer.write({
    type: "data-sandbox-fallback",
    id,
    data: fallbackInfo,
  });
}

export async function prepareSandboxContextForPrompt({
  sandboxManager,
  writer,
  eventId,
  onContextError,
}: {
  sandboxManager: SandboxContextForPromptManager;
  writer: UIMessageStreamWriter;
  eventId: string;
  onContextError?: (error: unknown) => void;
}): Promise<{
  sandboxContext: string | null;
  fallbackInfo: SandboxFallbackInfo | null;
}> {
  let sandboxContext: string | null = null;

  if (typeof sandboxManager.getSandboxContextForPrompt === "function") {
    try {
      sandboxContext = await sandboxManager.getSandboxContextForPrompt();
    } catch (error) {
      onContextError?.(error);
    }
  }

  const fallbackInfo = sandboxManager.consumeFallbackInfo?.() ?? null;
  if (fallbackInfo?.occurred) {
    writeSandboxFallbackEvent(writer, fallbackInfo, eventId);
    return { sandboxContext, fallbackInfo };
  }

  return { sandboxContext, fallbackInfo: null };
}

export function getSandboxFallbackPromptReminder(
  fallbackInfo: SandboxFallbackInfo | null,
): string | null {
  if (!fallbackInfo?.occurred) {
    return null;
  }

  if (fallbackInfo.actualSandbox === "e2b") {
    return `<sandbox_fallback>
Local sandbox unavailable. This run is using the Cloud sandbox. Cloud commands cannot access the user's Windows/macOS/Linux host files, drives such as C: or Z:, localhost, private LAN, or desktop apps. Do not promise host access or try to fix local host paths from Cloud. If the task requires the user's host, tell them to reconnect Desktop or a Remote Connection before continuing.
</sandbox_fallback>`;
  }

  const actualName = escapePromptText(
    fallbackInfo.actualSandboxName || "another local sandbox",
  );
  return `<sandbox_fallback>
The selected local sandbox is unavailable. This run switched to ${actualName}. Commands run only on that connected machine; do not assume access to the originally selected host.
</sandbox_fallback>`;
}
