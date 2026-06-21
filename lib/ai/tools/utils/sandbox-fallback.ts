import type { UIMessageStreamWriter } from "ai";
import { ChatSDKError } from "@/lib/errors";
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

const LOCAL_FALLBACK_BLOCK_MESSAGE =
  "Local sandbox is unavailable, so HackerAI did not switch this run to Cloud. Cloud cannot access your host files, drives, localhost, private networks, or desktop apps. Reconnect Desktop or a Remote Connection, or switch the sandbox to Cloud and send the message again.";

const SELECTED_LOCAL_FALLBACK_BLOCK_MESSAGE =
  "The selected local sandbox is unavailable, so HackerAI did not switch sandboxes because commands would run on the wrong host. Reconnect or select the right local sandbox, then send the message again.";

const LOCAL_ATTACHMENT_BLOCK_MESSAGE =
  "Desktop-local attachments require the Desktop sandbox. Reconnect Desktop, then resend the message with the attachment.";

const CLOUD_SANDBOX_TYPE = "e2b";

export function assertLocalSandboxFallbackAllowed({
  fallbackInfo,
  requireLocalSandbox = false,
}: {
  fallbackInfo: SandboxFallbackInfo | null;
  requireLocalSandbox?: boolean;
}): void {
  if (!fallbackInfo?.occurred) {
    return;
  }

  if (requireLocalSandbox) {
    throw new ChatSDKError("bad_request:api", LOCAL_ATTACHMENT_BLOCK_MESSAGE, {
      sandboxFallbackReason: fallbackInfo.reason,
      requestedPreference: fallbackInfo.requestedPreference,
      actualSandbox: fallbackInfo.actualSandbox,
      localSandboxRequired: true,
    });
  }

  const message =
    fallbackInfo.actualSandbox === CLOUD_SANDBOX_TYPE
      ? LOCAL_FALLBACK_BLOCK_MESSAGE
      : SELECTED_LOCAL_FALLBACK_BLOCK_MESSAGE;

  throw new ChatSDKError("bad_request:api", message, {
    sandboxFallbackReason: fallbackInfo.reason,
    requestedPreference: fallbackInfo.requestedPreference,
    actualSandbox: fallbackInfo.actualSandbox,
    localSandboxFallbackBlocked: true,
  });
}

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

  if (fallbackInfo.actualSandbox === CLOUD_SANDBOX_TYPE) {
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
